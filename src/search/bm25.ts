/** Document-level BM25 via FTS5 weighted columns (ADR-005/007). Ported from
 * `legacy/python/src/qkb/search/bm25.py` — same SQL, same weighted `bm25()`
 * call, same MATCH-query escaping. Ranking parity here feeds directly into
 * Task 13's RRF fusion, so this must be a port, not a reinterpretation.
 */

import type Database from "better-sqlite3";
import { buildFilterClause, type Filters } from "./filters.js";

// Matches Python's `re.findall(r"\w+", query, flags=re.UNICODE)`: any run of
// Unicode letters/digits/underscore. Approximates CPython's Unicode-aware
// `\w` (letters, digits, underscore) closely enough for query tokenization —
// both treat punctuation and FTS5 operator keywords (AND/OR/NOT/NEAR) as
// plain tokens once split out.
const WORD_RE = /[\p{L}\p{N}_]+/gu;

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
  const tokens = query.match(WORD_RE) ?? [];
  return tokens.map((t) => `"${t}"`).join(" ");
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
  // numeric arguments.
  const sql = `
    SELECT documents_fts.doc_id AS doc_id,
           -bm25(documents_fts, ${w.map((x) => String(x)).join(",")}) AS score,
           snippet(documents_fts, 3, '[', ']', '…', 12) AS snip
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
