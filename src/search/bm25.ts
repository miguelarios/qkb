/** Document-level BM25 via FTS5 weighted columns (ADR-005/007). Ported from
 * `legacy/python/src/qkb/search/bm25.py` — same SQL, same weighted `bm25()`
 * call, same MATCH-query escaping. Ranking parity here feeds directly into
 * Task 13's RRF fusion, so this must be a port, not a reinterpretation.
 */

import type Database from "better-sqlite3";
import { buildFilterClause, type Filters } from "./filters.js";

// Matches Python's `re.findall(r"\w+", query, flags=re.UNICODE)` — `re.UNICODE`
// is a no-op for str patterns in Python 3 (already the default), so this is
// really just `\w+`. `\p{L}\p{N}_` is not an approximation: CPython's `\w`
// resolves per-character to `Py_UNICODE_ISALNUM(ch) || ch == '_'`, and
// ISALNUM covers exactly the Lu/Ll/Lt/Lm/Lo (`\p{L}`) and Nd/Nl/No (`\p{N}`)
// categories — it does NOT extend to the Unicode "Alphabetic" derived
// property some regex engines use, so combining marks (Mn/Mc — accents in
// NFD text, Devanagari matras/virama) and connector punctuation other than
// ASCII `_` (Pc, e.g. U+203F UNDERTIE) are excluded from `\w` in both
// CPython and here. Verified empirically against CPython 3.14
// (`python3 -c "import re; re.findall(r'\w+', ...)"`) across representative
// Mn/Mc/Pc/Nl/No characters and NFD-normalized Latin/Devanagari/Vietnamese
// text — see the "NFD/Unicode word-boundary parity" tests in bm25.test.ts,
// which assert byte-identical tokenization against those same probes.
const WORD_RE = /[\p{L}\p{N}_]+/gu;

// INTERNAL match-marker delimiters `snippet()` wraps around a hit — control
// chars (U+0001/U+0002), not the public `[`/`]` Python parity requires.
// Obsidian markdown bodies routinely open with `- [ ] checklist` items or
// `[[wikilinks]]`, so literal brackets can appear in a snippet's opening
// words even when nothing actually matched there (a metadata-column-only
// hit, e.g. context matched but body didn't) — bracket-sniffing for "was
// there a real match" is therefore unsound (issue #14 critical fix; proven
// with a body starting `- [ ] buy milk…` and a context-only match, which
// used to print the checklist as if it were highlighted match evidence).
// Control chars can't collide with real markdown content, so `hasMatchMarkers`
// below is collision-proof. These never leave the process as-is: every
// public boundary that serializes `matched_text` (CLI `--json`, the MCP
// `qkb` tool's result, and the human evidence renderer's display string —
// see src/cli/shared.ts and src/server/mcp.ts) must call `toPublicMarkers`
// first to translate back to `[`/`]`, keeping `--json`/`--files`/MCP bytes
// byte-identical to before this change (Python parity). `--files` never
// carries `matched_text` at all, so it needs no translation call.
const MATCH_START = "\u0001";
const MATCH_END = "\u0002";

/** True when `text` carries `snippet()`'s internal match-marker control
 * chars — i.e. a real body-column hit, not just an unrelated `[`/`]` in the
 * document's opening words (markdown checklists/wikilinks). See the
 * `MATCH_START`/`MATCH_END` comment above for why bracket-sniffing doesn't
 * work here. */
export function hasMatchMarkers(text: string): boolean {
  return text.includes(MATCH_START);
}

/** Translates internal control-char match markers back to the public `[`/`]`
 * bracket markers every external consumer (Python parity, `--json`, MCP)
 * expects. A no-op on text with no markers (vector chunk text, marker-less
 * bm25 snippets) — safe to call unconditionally at a serialization
 * boundary. */
export function toPublicMarkers(text: string): string {
  return text.includes(MATCH_START)
    ? text.replaceAll(MATCH_START, "[").replaceAll(MATCH_END, "]")
    : text;
}

// Renders a number the way Python's `str(float)` would, for byte-identical
// SQL text against `bm25.py`'s f-string-interpolated weights (e.g. `5.0`,
// not JS's default `5`). Only exercised on the small literal weight list
// (`fts_weights` + the trailing `0.0`), so no exponential-notation handling
// is needed — `String(x)` never produces `e`/`E` for those magnitudes.
function formatSqlFloat(x: number): string {
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}

/**
 * Split a raw user query into its `\w+` word tokens (same definition `\w+`
 * uses everywhere else in this module — see `WORD_RE`'s docstring). Shared
 * by `sanitizeQuery` below and by the CLI's marker-less-match attribution
 * (src/cli/shared.ts's `matchAttribution`), which needs the same token set
 * to check a result's metadata columns without re-deriving FTS5 query syntax.
 */
export function queryTokens(query: string): string[] {
  return query.match(WORD_RE) ?? [];
}

/**
 * Tokenize a raw user query into a safely-quoted FTS5 MATCH expression.
 *
 * Every `\w+` token is wrapped in double quotes so it's treated as a literal
 * FTS5 string token rather than a query operator (AND/OR/NOT/NEAR/*) or
 * syntax the user typed by accident (unbalanced quotes, punctuation) — the
 * only characters that ever reach the MATCH string are the quoted tokens
 * themselves, so raw user input can't produce an FTS5 syntax error. A query
 * with no word tokens (e.g. `"!!!"`) sanitizes to `""`.
 *
 * Ported from `bm25.py`'s `sanitize_query`.
 */
export function sanitizeQuery(query: string): string {
  return queryTokens(query)
    .map((t) => `"${t}"`)
    .join(" ");
}

/**
 * Document-level BM25 search over `documents_fts`.
 *
 * Returns `[docId, score, snippet]` tuples ordered by score descending (best
 * first), capped at `limit`. `weights` are the five FTS5 column weights for
 * `title, tags, context, body, type` (config `fts_weights`, default
 * `[5, 3, 2, 1, 0.5]`) — inlined as literal SQL constants (not bound
 * parameters), matching Python's `bm25(documents_fts, 5,3,2,1,0.5)` call,
 * plus a trailing `0.0` weight for the UNINDEXED `doc_id` column. `bm25()`
 * returns lower-is-better; negated here (`-bm25(...)`) so `score` is
 * higher-is-better, matching every other ranking signal in this codebase.
 *
 * An empty/all-punctuation `query` sanitizes to `""`, which FTS5 MATCH can't
 * search — returns `[]` in that case without touching the database.
 *
 * Ported from `bm25.py`'s `search_bm25`.
 */
export function searchBm25(
  conn: Database.Database,
  query: string,
  filters: Filters,
  limit: number,
  weights: number[],
): [string, number, string][] {
  const match = sanitizeQuery(query);
  if (!match) {
    return [];
  }
  const [clause, params] = buildFilterClause(filters);
  const w = [...weights, 0.0]; // 6th weight for doc_id UNINDEXED
  // NOTE: no table alias on documents_fts — FTS5 MATCH needs the real table
  // name. Weights are inlined (not bound) — SQLite's bm25() requires literal
  // numeric arguments. snippet()'s start/end markers are also inlined as
  // literal SQL string text (not bound params) — same as the weights — using
  // the internal control-char markers (see MATCH_START/MATCH_END's comment
  // above), not the public `[`/`]`.
  const sql = `
    SELECT documents_fts.doc_id AS doc_id,
           -bm25(documents_fts, ${w.map(formatSqlFloat).join(",")}) AS score,
           snippet(documents_fts, 3, '${MATCH_START}', '${MATCH_END}', '…', 12) AS snip
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.doc_id
    WHERE documents_fts MATCH ? AND ${clause}
    ORDER BY score DESC
    LIMIT ?
  `;
  const rows = conn.prepare(sql).all(match, ...params, limit) as {
    doc_id: string;
    score: number;
    snip: string;
  }[];
  return rows.map((r) => [r.doc_id, r.score, r.snip]);
}
