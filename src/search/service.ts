/** Shared search orchestration for the CLI and MCP entry points. Ported from
 * `legacy/python/src/qkb/search/service.py`.
 *
 * Both the CLI query path and the MCP `qkb` tool call `executeSearch` so the
 * "resolve limit -> validate -> guard -> run tiered search -> hydrate"
 * pipeline can't diverge between them (Python review finding: the MCP tool
 * had drifted from the CLI — hardcoded limit, duplicated the tiered-search
 * call inline).
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { vectorTableDimension } from "../db/schema.js";
import { Storage } from "../db/storage.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { QueryExpander, QueryVariant } from "../llm/expand.js";
import { blendScore, type Reranker, words } from "../llm/rerank.js";
import { hasMatchMarkers } from "./bm25.js";
import { SearchValidationError } from "./errors.js";
import type { Filters } from "./filters.js";
import { type RankedResult, search as runSearch } from "./hybrid.js";
import { type HydratedResult, hydrate } from "./hydrate.js";

/** Optional model stages around retrieval. Each is skipped when null. */
export interface SearchExtras {
  /** Rewrites the query into variants fused into hybrid search (#38). */
  expander?: QueryExpander | null;
  /** Re-scores the top `cfg.rerankCandidates` hits (#37). */
  reranker?: Reranker | null;
  /** Told when an optional stage fails and search falls back without it. */
  onWarning?: (message: string) => void;
}

/**
 * Resolve `limit` (`null` -> `cfg.defaultLimit`), reject a resolved limit below
 * 1, guard against an untrustworthy index, then run the tiered search.
 *
 * Throws (all as `SearchValidationError`, mirroring Python's `ValueError`) if:
 * - a `--full` re-embed is in progress or was interrupted — an untrustworthy
 *   index must not be searched silently (Python finding 2); every tier is
 *   blocked, bm25 included.
 * - the resolved limit is < 1 — `--limit 0`/negative is rejected rather than
 *   silently becoming "unbounded" (SQLite `LIMIT -1`) or "10".
 * - for vector-using tiers, `chunks_vec` was built at a different embedding
 *   dimension than `cfg` now expects (Python finding 5 — a friendly error
 *   instead of sqlite-vec's raw dimension error). bm25 never touches
 *   `chunks_vec`, so a dimension mismatch must not block it.
 *
 * Ported from `service.py`'s `execute_search`.
 */
export async function executeSearch(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider | null,
  query: string,
  filters: Filters,
  limit: number | null,
  tier: string,
  extras: SearchExtras = {},
): Promise<HydratedResult[]> {
  if (new Storage(conn).isIngestInProgress()) {
    throw new SearchValidationError(
      "index rebuild in progress or interrupted — re-run `qkb ingest --full` " +
        "to finish re-embedding before searching",
    );
  }
  const resolvedLimit = limit ?? cfg.defaultLimit;
  if (resolvedLimit < 1) {
    throw new SearchValidationError(`limit must be >= 1, got ${resolvedLimit}`);
  }
  if (tier !== "bm25") {
    const tableDim = vectorTableDimension(conn);
    if (tableDim !== null && tableDim !== cfg.embeddingDim) {
      throw new SearchValidationError(
        `embedding dimension changed since last ingest ` +
          `(index is ${tableDim}-d, config is ${cfg.embeddingDim}-d) — ` +
          `run \`qkb embed --full\` to re-embed the whole vault`,
      );
    }
  }
  const warn = extras.onWarning ?? (() => {});
  let variants: QueryVariant[] = [];
  if (extras.expander && tier === "hybrid") {
    try {
      variants = await extras.expander.expand(query);
    } catch (e) {
      warn(`query expansion failed, searching without it: ${errorMessage(e)}`);
    }
  }
  const reranker = extras.reranker ?? null;
  const fetchN = reranker ? Math.max(resolvedLimit, cfg.rerankCandidates) : resolvedLimit;
  let ranked = await runSearch(conn, cfg, provider, query, filters, fetchN, tier, variants);
  if (reranker && ranked.length > 0) {
    try {
      ranked = await rerank(conn, reranker, query, ranked);
    } catch (e) {
      warn(`reranking failed, returning unreranked results: ${errorMessage(e)}`);
    }
  }
  return hydrate(conn, ranked.slice(0, resolvedLimit));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Re-score `ranked` with the reranker and blend with retrieval rank
 * (`blendScore`). Each candidate is shown to the model as its title, its
 * declared-field lines and one passage: the vector chunk that matched, or —
 * when retrieval only has a BM25 snippet — the chunk sharing the most words
 * with the query.
 */
async function rerank(
  conn: Database.Database,
  reranker: Reranker,
  query: string,
  ranked: RankedResult[],
): Promise<RankedResult[]> {
  const ids = ranked.map(([d]) => d);
  const marks = ids.map(() => "?").join(",");
  const docs = new Map(
    (
      conn
        .prepare(`SELECT id, title, fields_text FROM documents WHERE id IN (${marks})`)
        .all(...ids) as { id: string; title: string; fields_text: string | null }[]
    ).map((r) => [r.id, r]),
  );
  const chunks = new Map<string, string[]>();
  for (const r of conn
    .prepare(
      `SELECT document_id, chunk_text FROM chunks WHERE document_id IN (${marks}) ORDER BY chunk_index`,
    )
    .all(...ids) as { document_id: string; chunk_text: string }[]) {
    const list = chunks.get(r.document_id) ?? [];
    list.push(r.chunk_text);
    chunks.set(r.document_id, list);
  }
  const q = new Set(words(query));
  const bestChunk = (docId: string): string => {
    let best = "";
    let bestHits = -1;
    for (const c of chunks.get(docId) ?? []) {
      const hits = words(c).filter((w) => q.has(w)).length;
      if (hits > bestHits) [best, bestHits] = [c, hits];
    }
    return best;
  };
  const texts = ranked.map(([d, , matched]) => {
    const doc = docs.get(d);
    const passage = matched && !hasMatchMarkers(matched) ? matched : bestChunk(d);
    return [doc?.title, doc?.fields_text, passage].filter(Boolean).join("\n");
  });
  const scores = await reranker.rank(query, texts);
  return ranked
    .map(([d, , matched], i) => [d, blendScore(i + 1, scores[i] ?? 0), matched] as RankedResult)
    .sort((a, b) => b[1] - a[1]);
}
