/** Chunk-level vector search, deduplicated to documents (DESIGN.md §8.1 tier
 * 2). Ported from `legacy/python/src/qkb/search/vector.py` — same KNN SQL,
 * same filter pre-restriction, same iterative pool-growth and dedup
 * semantics. Ranking/dedup parity here feeds directly into Task 13's RRF
 * fusion, so this must be a port, not a reinterpretation.
 */

import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../embed/types.js";
import { buildFilterClause, type Filters } from "./filters.js";

/**
 * Chunk-level KNN vector search, deduplicated to one best-scoring row per
 * document. Returns `[docId, score, chunkText]` tuples ordered by score
 * descending (best first), capped at `limit`. `score` is `1 - distance`
 * (cosine distance from `chunks_vec`), so higher is better — matching every
 * other ranking signal in this codebase.
 *
 * When `filters` restrict the search, the KNN candidate set is restricted to
 * filter-passing chunks BEFORE the vector search runs (`chunk_id IN (...)`),
 * rather than running an unrestricted global top-k search and discarding
 * non-matching rows afterward. The old global-then-filter approach could
 * return zero results even when filter-passing matches exist outside the
 * global top-k (review finding 5; DESIGN.md §8.5 promises the candidate set
 * is restricted before search). No fudge-factor multiplier on `k` is needed:
 * since the pool is already restricted to filter-passing chunks, every row
 * returned already qualifies.
 *
 * `k` sizes a pool of CHUNKS while the result loop below dedups to
 * best-chunk-per-DOCUMENT and stops at `limit` documents — on any vault whose
 * docs average more than one chunk, a few long documents can crowd the chunk
 * pool and starve the document-level result set (review finding 3). So the
 * pool grows iteratively until `limit` distinct documents are collected or
 * the candidate chunk set is exhausted, rather than being sized once from
 * `candidates`/`limit` alone. The KNN pool must also be at least as large as
 * the requested output `limit`, or a large `limit` gets silently truncated to
 * a smaller fixed candidate count (review finding 6).
 *
 * Partial-index-safe: works correctly with a partially-embedded index (fewer
 * vectors in `chunks_vec` than rows in `chunks`) — `total_chunks` reflects
 * only what's actually searchable, and an empty vector index returns `[]`
 * without erroring.
 *
 * Ported from `vector.py`'s `search_vector`.
 */
export async function searchVector(
  conn: Database.Database,
  query: string,
  filters: Filters,
  limit: number,
  candidates: number,
  provider: EmbeddingProvider,
): Promise<[string, number, string][]> {
  const qvec = await provider.embedQuery(query);
  const [clause, params] = buildFilterClause(filters);
  const hasFilters = clause !== "1=1";

  let restrict = "";
  let totalChunks: number;
  if (hasFilters) {
    restrict =
      "AND chunk_id IN (" +
      "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id " +
      `WHERE ${clause})`;
    totalChunks = (
      conn
        .prepare(
          "SELECT COUNT(*) AS c FROM chunks c JOIN documents d ON d.id = c.document_id " +
            `WHERE ${clause}`,
        )
        .get(...params) as { c: number }
    ).c;
  } else {
    totalChunks = (conn.prepare("SELECT COUNT(*) AS c FROM chunks_vec").get() as { c: number }).c;
  }
  if (totalChunks === 0) {
    return [];
  }

  const sql = `
    WITH knn AS (
        SELECT chunk_id, distance
        FROM chunks_vec
        WHERE embedding MATCH ? AND k = ? ${restrict}
    )
    SELECT c.document_id AS doc_id,
           1.0 - knn.distance AS score,
           c.chunk_text AS chunk_text
    FROM knn
    JOIN chunks c ON c.id = knn.chunk_id
    ORDER BY knn.distance ASC
  `;
  const stmt = conn.prepare(sql);
  const qvecBytes = new Float32Array(qvec);

  let k = Math.min(Math.max(candidates, limit), totalChunks);
  let out: [string, number, string][] = [];
  while (true) {
    const rows = stmt.all(qvecBytes, k, ...params) as {
      doc_id: string;
      score: number;
      chunk_text: string;
    }[];
    out = [];
    const seen = new Set<string>();
    for (const r of rows) {
      // already best-first; keep best chunk per document
      if (seen.has(r.doc_id)) {
        continue;
      }
      seen.add(r.doc_id);
      out.push([r.doc_id, r.score, r.chunk_text]);
      if (out.length >= limit) {
        break;
      }
    }
    if (out.length >= limit || k >= totalChunks) {
      break;
    }
    k = Math.min(k * 2, totalChunks);
  }
  return out.slice(0, limit);
}
