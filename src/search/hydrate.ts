/** Hydrate ranked doc ids into the full result JSON contract (DESIGN.md §8.6).
 * Ported from `legacy/python/src/qkb/search/results.py`.
 *
 * KEY NAMING: every key on `HydratedResult`/`RelatedNote` is snake_case
 * (`document_id`, `effective_date`, `obsidian_uri`, `matched_text`, ...), as
 * Python's dict keys were, not the camelCase convention the rest
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

/** How a related note connects to a result. */
export type Relation = "links_to" | "linked_from" | "same_source";

/** A note connected to a result by a wikilink (either direction) or by a
 * shared `source` value (#36). */
export interface RelatedNote {
  document_id: string;
  title: string | null;
  type: string;
  file_path: string;
  obsidian_uri: string;
  relation: Relation;
}

/** Related notes returned per search result (a `qkb get` returns them all). */
export const RELATED_PER_RESULT = 10;

/** The full per-result JSON contract `hydrate` produces. */
export interface HydratedResult {
  document_id: string;
  title: string | null;
  type: string;
  effective_date: string;
  score: number;
  file_path: string;
  obsidian_uri: string;
  matched_text: string | null;
  tags: string[];
  /** Notes this one links to, notes linking to it, and notes sharing its
   * `source` — capped at RELATED_PER_RESULT in search results. */
  related: RelatedNote[];
  /** Name of the vault the note was indexed from. */
  vault: string;
  /** Declared extra properties present on the note (`[frontmatter.fields]`). */
  fields: Record<string, string>;
}

/** Inverse of `renderFields`: `key: value` lines back into an object.
 * `renderFields` flattens newlines inside values, so one line = one field. */
export function parseFieldsText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2);
  }
  return out;
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

interface DocumentRow {
  id: string;
  type: string;
  effective_date: string;
  created_at: string;
  file_path: string;
  content_hash: string;
  title: string | null;
  vault_name: string;
  indexed_at: string;
  fields_text: string;
  stem_key: string;
  path_key: string;
}

type RefRow = Pick<DocumentRow, "id" | "title" | "type" | "file_path" | "vault_name">;

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

/** Every lowercase name a `[[link]]` can use for each document: file name,
 * vault path, title, aliases. */
function linkNames(conn: Database.Database, docs: DocumentRow[]): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const d of docs) {
    const set = new Set([d.stem_key, d.path_key]);
    if (d.title) set.add(d.title.toLowerCase());
    names.set(d.id, set);
  }
  if (docs.length > 0) {
    const rows = conn
      .prepare(
        `SELECT document_id, alias FROM aliases WHERE document_id IN (${placeholders(docs.length)})`,
      )
      .all(...docs.map((d) => d.id)) as { document_id: string; alias: string }[];
    for (const r of rows) names.get(r.document_id)?.add(r.alias.toLowerCase());
  }
  for (const set of names.values()) set.delete("");
  return names;
}

/** Documents in `vault` that a lowercase link target names. */
function resolveTargets(
  conn: Database.Database,
  targets: string[],
  vault: string,
): Map<string, RefRow[]> {
  const out = new Map<string, RefRow[]>();
  if (targets.length === 0) return out;
  const marks = placeholders(targets.length);
  const rows = conn
    .prepare(
      `SELECT d.id, d.title, d.type, d.file_path, d.vault_name, k.key AS key FROM (
         SELECT id, stem_key AS key FROM documents WHERE stem_key IN (${marks})
         UNION SELECT id, path_key FROM documents WHERE path_key IN (${marks})
         UNION SELECT id, lower(title) FROM documents WHERE lower(title) IN (${marks})
         UNION SELECT document_id, lower(alias) FROM aliases WHERE lower(alias) IN (${marks})
       ) k JOIN documents d ON d.id = k.id WHERE d.vault_name = ?`,
    )
    .all(...targets, ...targets, ...targets, ...targets, vault) as (RefRow & { key: string })[];
  for (const r of rows) {
    const list = out.get(r.key) ?? [];
    if (!list.some((x) => x.id === r.id)) list.push(r);
    out.set(r.key, list);
  }
  return out;
}

/**
 * Related notes for each document, most direct first: notes it links to, then
 * notes linking to it (both within its vault), then notes sharing its `source`
 * property. Each note appears once, under its first relation.
 */
export function relatedNotes(
  conn: Database.Database,
  docs: DocumentRow[],
  cap: number | null,
): Map<string, RelatedNote[]> {
  const out = new Map<string, RelatedNote[]>();
  if (docs.length === 0) return out;
  const ids = docs.map((d) => d.id);
  const idMarks = placeholders(ids.length);
  const names = linkNames(conn, docs);

  // Outgoing links.
  const outRows = conn
    .prepare(
      `SELECT document_id, target FROM links WHERE document_id IN (${idMarks}) ORDER BY position`,
    )
    .all(...ids) as { document_id: string; target: string }[];
  const outgoing = new Map<string, string[]>();
  for (const r of outRows)
    outgoing.set(r.document_id, [...(outgoing.get(r.document_id) ?? []), r.target]);

  // Backlinks: links whose target is one of a result's names.
  const allNames = [...new Set([...names.values()].flatMap((s) => [...s]))];
  const inRows =
    allNames.length === 0
      ? []
      : (conn
          .prepare(
            `SELECT l.target, d.id, d.title, d.type, d.file_path, d.vault_name
               FROM links l JOIN documents d ON d.id = l.document_id
              WHERE l.target IN (${placeholders(allNames.length)}) ORDER BY d.title`,
          )
          .all(...allNames) as (RefRow & { target: string })[]);

  // Shared source.
  const srcRows = conn
    .prepare(
      `SELECT document_id, value FROM metadata WHERE key = 'source' AND document_id IN (${idMarks})`,
    )
    .all(...ids) as { document_id: string; value: string }[];
  const sourceOf = new Map(srcRows.map((r) => [r.document_id, r.value]));
  const sources = [...new Set(sourceOf.values())];
  const bySource = new Map<string, RefRow[]>();
  if (sources.length > 0) {
    const rows = conn
      .prepare(
        `SELECT m.value, d.id, d.title, d.type, d.file_path, d.vault_name
           FROM metadata m JOIN documents d ON d.id = m.document_id
          WHERE m.key = 'source' AND m.value IN (${placeholders(sources.length)}) ORDER BY d.title`,
      )
      .all(...sources) as (RefRow & { value: string })[];
    for (const r of rows) bySource.set(r.value, [...(bySource.get(r.value) ?? []), r]);
  }

  const resolvedByVault = new Map<string, Map<string, RefRow[]>>();
  for (const d of docs) {
    let resolved = resolvedByVault.get(d.vault_name);
    if (resolved === undefined) {
      const vaultTargets = [
        ...new Set(
          docs
            .filter((x) => x.vault_name === d.vault_name)
            .flatMap((x) => outgoing.get(x.id) ?? []),
        ),
      ];
      resolved = resolveTargets(conn, vaultTargets, d.vault_name);
      resolvedByVault.set(d.vault_name, resolved);
    }
    const list: RelatedNote[] = [];
    const seen = new Set([d.id]);
    const add = (r: RefRow, relation: Relation): void => {
      if (seen.has(r.id) || (cap !== null && list.length >= cap)) return;
      seen.add(r.id);
      list.push({
        document_id: r.id,
        title: r.title,
        type: r.type,
        file_path: r.file_path,
        obsidian_uri: obsidianUri(r.vault_name, r.file_path),
        relation,
      });
    };
    for (const t of outgoing.get(d.id) ?? []) {
      for (const r of resolved.get(t) ?? []) add(r, "links_to");
    }
    const myNames = names.get(d.id) ?? new Set();
    for (const r of inRows) {
      if (r.vault_name === d.vault_name && myNames.has(r.target)) add(r, "linked_from");
    }
    const src = sourceOf.get(d.id);
    if (src !== undefined) {
      for (const r of bySource.get(src) ?? []) add(r, "same_source");
    }
    out.set(d.id, list);
  }
  return out;
}

/** Round to 6 decimal places, mirroring Python's `round(score, 6)` for the
 * float magnitudes RRF/BM25 scores take. Not a general banker's-rounding
 * port — see hydrate.test.ts for the pinned values this must reproduce. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Hydrate `[docId, score, matchedText]` tuples into the full result contract:
 * doc metadata, tags, declared fields, Obsidian URI, and related notes
 * (wikilinks both ways plus shared `source`), surfaced without a second query.
 *
 * Missing doc ids (deleted since the tuples were ranked) are silently
 * skipped; result order otherwise matches `ranked`. Ported from
 * `results.py`'s `hydrate`. `relatedCap` limits related notes per result
 * (null = all, for `qkb get`).
 */
export function hydrate(
  conn: Database.Database,
  ranked: RankedResult[],
  relatedCap: number | null = RELATED_PER_RESULT,
): HydratedResult[] {
  const docIds = ranked.map(([docId]) => docId);
  const docRows = batchDocRows(conn, docIds);
  const presentIds = docIds.filter((id) => docRows.has(id));
  const tagsByDoc = batchTags(conn, presentIds);
  const related = relatedNotes(
    conn,
    presentIds.map((id) => docRows.get(id) as DocumentRow),
    relatedCap,
  );

  const out: HydratedResult[] = [];
  for (const [docId, score, matchedText] of ranked) {
    const d = docRows.get(docId);
    if (d === undefined) {
      continue;
    }
    out.push({
      document_id: d.id,
      title: d.title,
      type: d.type,
      effective_date: d.effective_date,
      score: round6(score),
      file_path: d.file_path,
      obsidian_uri: obsidianUri(d.vault_name, d.file_path),
      matched_text: matchedText,
      tags: tagsByDoc.get(docId) ?? [],
      related: related.get(docId) ?? [],
      vault: d.vault_name,
      fields: parseFieldsText(d.fields_text ?? ""),
    });
  }
  return out;
}
