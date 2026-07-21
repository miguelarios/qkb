/** RRF fusion and search-tier orchestration (DESIGN.md §8.1-8.2). Ported from
 * `legacy/python/src/qkb/search/hybrid.py`.
 *
 * THIS IS THE GOLDEN-QUERY BAR: fusion ordering parity with Python is the
 * whole point, so this is a port, not a reinterpretation. Two ordering
 * invariants are load-bearing and must match Python exactly:
 *
 *   1. Score accumulation order. Python iterates the result lists in order
 *      (BM25 first, then vector), and each list in rank order, accumulating
 *      into a `defaultdict(float)`. A JS `Map<string, number>` reproduces this:
 *      both are insertion-ordered, both accumulate with IEEE-754 doubles in the
 *      same sequence of operations, so identical inputs yield byte-identical
 *      scores AND identical first-appearance order.
 *   2. Tie-break. Python returns `sorted(scores.items(), reverse=True)`.
 *      CPython's sort is stable and `reverse=True` keeps equal-key records in
 *      their ORIGINAL (insertion) order — it does not reverse ties. JS
 *      `Array.prototype.sort` is likewise stable (ES2019+/Node ≥12), so
 *      `entries.sort((a, b) => b[1] - a[1])` over the insertion-ordered Map
 *      entries produces the same tie order (first-appearance across the
 *      BM25-then-vector iteration).
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../embed/types.js";
import { searchBm25 } from "./bm25.js";
import { SearchValidationError } from "./errors.js";
import type { Filters } from "./filters.js";
import { searchVector } from "./vector.js";

/** A ranked search hit: `[docId, score, matchedText]`. `matchedText` is the
 * vector chunk text or BM25 snippet (or `null` when neither leg supplied one) —
 * mirrors Python's `tuple[str, float, str | None]`. */
export type RankedResult = [string, number, string | null];

/**
 * Reciprocal Rank Fusion over one or more ranked result lists.
 *
 * Each list contributes `weight * (1 / (k + rank + 1))` to every doc it ranks
 * (`rank` is 0-based). Scores accumulate across lists, then results are sorted
 * by score descending. Only `docId` and rank matter — the per-list score in the
 * input tuple is ignored (matching Python's `for rank, (doc_id, _) in ...`).
 *
 * Ties keep first-appearance order (see the module docstring's invariant 2).
 *
 * Ported from `hybrid.py`'s `rrf_merge`.
 */
export function rrfMerge(
  resultLists: Array<Array<[string, number]>>,
  k = 60,
  weights?: number[],
): Array<[string, number]> {
  const w = weights ?? new Array<number>(resultLists.length).fill(1.0);
  if (w.length !== resultLists.length) {
    // Parity with Python's `zip(..., strict=True)`, which raises ValueError.
    throw new SearchValidationError("weights and result_lists must be the same length");
  }
  const scores = new Map<string, number>();
  for (let i = 0; i < resultLists.length; i++) {
    const weight = w[i] as number;
    const results = resultLists[i] as Array<[string, number]>;
    for (let rank = 0; rank < results.length; rank++) {
      const docId = (results[rank] as [string, number])[0];
      scores.set(docId, (scores.get(docId) ?? 0) + weight * (1.0 / (k + rank + 1)));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Run one search tier and return ranked `[docId, score, matchedText]` hits.
 *
 * - `bm25`: document-level BM25 only; needs no embedding provider.
 * - `vector`: chunk-level KNN deduped to documents; requires a provider.
 * - `hybrid`: RRF fusion (`cfg.rrfK`) of the BM25 list and the vector list.
 *   Each leg is sized to `max(limit, cfg.ftsCandidates | cfg.vecCandidates)` so
 *   a large `--limit` above the fixed candidate pool still reaches `limit`
 *   results per leg before fusion (Python review finding 6), then the fused
 *   list is cut to `limit`. Matched text prefers the vector chunk text and
 *   falls back to the BM25 snippet.
 *
 * Ported from `hybrid.py`'s `search`.
 */
export async function search(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider | null,
  query: string,
  filters: Filters,
  limit: number,
  tier: string,
): Promise<RankedResult[]> {
  if (tier === "bm25") {
    const rows = searchBm25(conn, query, filters, limit, cfg.ftsWeights);
    return rows.map(([d, s, snip]) => [d, s, snip] as RankedResult);
  }
  if (provider === null) {
    throw new SearchValidationError(`tier '${tier}' requires an embedding provider`);
  }
  if (tier === "vector") {
    const rows = await searchVector(conn, query, filters, limit, cfg.vecCandidates, provider);
    return rows.map(([d, s, text]) => [d, s, text] as RankedResult);
  }
  if (tier === "hybrid") {
    // Requesting `limit` above the default candidate pool must still reach
    // `limit` results on each leg, or the fixed pool size silently truncates a
    // large --limit (Python review finding 6).
    const bmN = Math.max(limit, cfg.ftsCandidates);
    const vecN = Math.max(limit, cfg.vecCandidates);
    const bm = searchBm25(conn, query, filters, bmN, cfg.ftsWeights);
    // searchVector owns pool sizing internally (it clamps and grows `k` from
    // `candidates` as needed to fill `limit` distinct documents), so pass the
    // intended values distinctly instead of duplicating the max(limit, ...)
    // policy at this call site.
    const vec = await searchVector(conn, query, filters, vecN, cfg.vecCandidates, provider);
    const merged = rrfMerge(
      [
        bm.map(([d, s]) => [d, s] as [string, number]),
        vec.map(([d, s]) => [d, s] as [string, number]),
      ],
      cfg.rrfK,
    );
    const chunkText = new Map<string, string>(vec.map(([d, , t]) => [d, t]));
    const snippet = new Map<string, string>(bm.map(([d, , s]) => [d, s]));
    return merged.slice(0, limit).map(
      ([docId, score]) =>
        // `||` (not `??`) matches Python's `chunk_text.get(d) or snippet.get(d)`:
        // an empty-string chunk text falls through to the snippet.
        [docId, score, (chunkText.get(docId) || snippet.get(docId)) ?? null] as RankedResult,
    );
  }
  throw new SearchValidationError(`unknown tier: '${tier}'`);
}
