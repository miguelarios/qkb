/** Hydrate ranked doc ids into the full result JSON contract (DESIGN.md §8.6).
 * Ported from `legacy/python/src/qkb/search/results.py`.
 *
 * KEY NAMING: every key on `HydratedResult`/`Sibling` is Python's dict key
 * verbatim (snake_case: `document_id`, `effective_date`, `context_description`,
 * `obsidian_uri`, `matched_text`, ...), not the camelCase convention the rest
 * of this codebase uses for TS-internal types. This is deliberate: Tasks
 * 15/16 (CLI `--json`, MCP) serialize this shape directly, and Python's CLI
 * does `json.dumps(results, indent=2)` on the dict as-is (see
 * `legacy/python/src/qkb/cli.py` `_emit`). Keeping the keys identical here
 * means the JSON emitters need no remapping step and can't drift from
 * Python's output — the simplest option the task brief called out.
 */

import type Database from "better-sqlite3";
import { placeholders } from "../db/schema.js";
import type { RankedResult } from "./hybrid.js";

/** A sibling document sharing `source` with a hydrated result. */
export interface Sibling {
  document_id: string;
  title: string | null;
  type: string;
  file_path: string;
  obsidian_uri: string;
}

/** The full per-result JSON contract `hydrate` produces. */
export interface HydratedResult {
  document_id: string;
  title: string | null;
  type: string;
  context: string | null;
  context_description: string | null;
  source: string | null;
  effective_date: string;
  score: number;
  file_path: string;
  obsidian_uri: string;
  matched_text: string | null;
  tags: string[];
  siblings: Sibling[];
}

// ASCII letters/digits/`_.-~` — Python's `urllib.parse.quote` ALWAYS_SAFE set.
const PY_QUOTE_SAFE = /^[A-Za-z0-9_.\-~]$/;

/**
 * Percent-encode UTF-8 bytes exactly like Python's
 * `urllib.parse.quote(s, safe="")`.
 *
 * `encodeURIComponent` is close but not identical: it leaves `!'()*`
 * unescaped, while Python's `quote` (with `safe=""`) percent-encodes them
 * too. `test_obsidian_uri` pins the exact expected string, so this ports the
 * byte-by-byte encoding rather than relying on the near-miss builtin.
 */
function pyQuote(s: string): string {
  const bytes = Buffer.from(s, "utf-8");
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && PY_QUOTE_SAFE.test(ch)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Build an `obsidian://open?vault=&file=` deep link. `file_path`'s `.md`
 * suffix is stripped (Obsidian resolves note links without the extension).
 * Ported from `results.py`'s `obsidian_uri`. */
export function obsidianUri(vaultName: string, filePath: string): string {
  const path = filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
  return `obsidian://open?vault=${pyQuote(vaultName)}&file=${pyQuote(path)}`;
}

/** Look up a context's description, or null if absent/context is null-ish.
 * Ported from `results.py`'s `context_description`. */
export function contextDescription(
  conn: Database.Database,
  context: string | null | undefined,
): string | null {
  if (!context) {
    return null;
  }
  const row = conn
    .prepare("SELECT description FROM context_descriptions WHERE context = ?")
    .get(context) as { description: string } | undefined;
  return row ? row.description : null;
}

interface DocumentRow {
  id: string;
  type: string;
  context: string | null;
  source: string | null;
  effective_date: string;
  created_at: string;
  file_path: string;
  content_hash: string;
  title: string | null;
  vault_name: string;
  indexed_at: string;
}

interface SiblingCandidateRow {
  id: string;
  title: string | null;
  type: string;
  file_path: string;
  vault_name: string;
  source: string | null;
}

function batchDocRows(conn: Database.Database, docIds: string[]): Map<string, DocumentRow> {
  const byId = new Map<string, DocumentRow>();
  if (docIds.length === 0) {
    return byId;
  }
  const rows = conn
    .prepare(`SELECT * FROM documents WHERE id IN (${placeholders(docIds.length)})`)
    .all(...docIds) as DocumentRow[];
  for (const r of rows) {
    byId.set(r.id, r);
  }
  return byId;
}

function batchTags(conn: Database.Database, docIds: string[]): Map<string, string[]> {
  const tagsByDoc = new Map<string, string[]>();
  for (const id of docIds) {
    tagsByDoc.set(id, []);
  }
  if (docIds.length === 0) {
    return tagsByDoc;
  }
  const rows = conn
    .prepare(
      `SELECT document_id, tag FROM tags WHERE document_id IN (${placeholders(docIds.length)}) ORDER BY tag`,
    )
    .all(...docIds) as { document_id: string; tag: string }[];
  for (const r of rows) {
    tagsByDoc.get(r.document_id)?.push(r.tag);
  }
  return tagsByDoc;
}

function batchContextDescriptions(
  conn: Database.Database,
  contexts: Array<string | null>,
): Map<string, string> {
  const unique = [...new Set(contexts.filter((c): c is string => Boolean(c)))].sort();
  const byContext = new Map<string, string>();
  if (unique.length === 0) {
    return byContext;
  }
  const rows = conn
    .prepare(
      `SELECT context, description FROM context_descriptions WHERE context IN (${placeholders(unique.length)})`,
    )
    .all(...unique) as { context: string; description: string }[];
  for (const r of rows) {
    byContext.set(r.context, r.description);
  }
  return byContext;
}

/** All sibling candidate rows grouped by source, ordered by title (so the
 * per-doc filtering in `hydrate` just excludes self, preserving title order). */
function batchSiblings(
  conn: Database.Database,
  sources: Array<string | null>,
): Map<string, SiblingCandidateRow[]> {
  const unique = [...new Set(sources.filter((s): s is string => Boolean(s)))].sort();
  const bySource = new Map<string, SiblingCandidateRow[]>();
  for (const s of unique) {
    bySource.set(s, []);
  }
  if (unique.length === 0) {
    return bySource;
  }
  const rows = conn
    .prepare(
      `SELECT id, title, type, file_path, vault_name, source FROM documents ` +
        `WHERE source IN (${placeholders(unique.length)}) ORDER BY title`,
    )
    .all(...unique) as SiblingCandidateRow[];
  for (const r of rows) {
    // r.source is non-null: `unique` only contains non-null sources and the
    // WHERE clause filters to those exact values.
    bySource.get(r.source as string)?.push(r);
  }
  return bySource;
}

/** Round to 6 decimal places, mirroring Python's `round(score, 6)` for the
 * float magnitudes RRF/BM25 scores take. Not a general banker's-rounding
 * port — see hydrate.test.ts for the pinned values this must reproduce. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Hydrate `[docId, score, matchedText]` tuples into the full result-dict
 * contract: doc metadata, tags, context description, Obsidian URI, and
 * siblings (other documents sharing the same `source`, surfaced without a
 * second search query).
 *
 * Missing doc ids (deleted since the tuples were ranked) are silently
 * skipped; result order otherwise matches `ranked`. Ported from
 * `results.py`'s `hydrate`.
 */
export function hydrate(conn: Database.Database, ranked: RankedResult[]): HydratedResult[] {
  const docIds = ranked.map(([docId]) => docId);
  const docRows = batchDocRows(conn, docIds);
  const presentIds = docIds.filter((id) => docRows.has(id));

  const tagsByDoc = batchTags(conn, presentIds);
  const contexts = presentIds.map((id) => docRows.get(id)?.context ?? null);
  const descriptionsByContext = batchContextDescriptions(conn, contexts);
  const sources = presentIds.map((id) => docRows.get(id)?.source ?? null);
  const siblingsBySource = batchSiblings(conn, sources);

  const out: HydratedResult[] = [];
  for (const [docId, score, matchedText] of ranked) {
    const d = docRows.get(docId);
    if (d === undefined) {
      continue;
    }
    const siblings: Sibling[] = (d.source ? (siblingsBySource.get(d.source) ?? []) : [])
      .filter((r) => r.id !== docId)
      .map((r) => ({
        document_id: r.id,
        title: r.title,
        type: r.type,
        file_path: r.file_path,
        obsidian_uri: obsidianUri(r.vault_name, r.file_path),
      }));
    out.push({
      document_id: d.id,
      title: d.title,
      type: d.type,
      context: d.context,
      context_description: d.context ? (descriptionsByContext.get(d.context) ?? null) : null,
      source: d.source,
      effective_date: d.effective_date,
      score: round6(score),
      file_path: d.file_path,
      obsidian_uri: obsidianUri(d.vault_name, d.file_path),
      matched_text: matchedText,
      tags: tagsByDoc.get(docId) ?? [],
      siblings,
    });
  }
  return out;
}
