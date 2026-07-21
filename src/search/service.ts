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
import type { Filters } from "./filters.js";
import { search as runSearch } from "./hybrid.js";
import { type HydratedResult, hydrate } from "./hydrate.js";

/**
 * Resolve `limit` (`null` -> `cfg.defaultLimit`), reject a resolved limit below
 * 1, guard against an untrustworthy index, then run the tiered search.
 *
 * Throws (all as `Error`, mirroring Python's `ValueError`) if:
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
): Promise<HydratedResult[]> {
  if (new Storage(conn).isIngestInProgress()) {
    throw new Error(
      "index rebuild in progress or interrupted — re-run `qkb ingest --full` " +
        "to finish re-embedding before searching",
    );
  }
  const resolvedLimit = limit ?? cfg.defaultLimit;
  if (resolvedLimit < 1) {
    throw new Error(`limit must be >= 1, got ${resolvedLimit}`);
  }
  if (tier !== "bm25") {
    const tableDim = vectorTableDimension(conn);
    if (tableDim !== null && tableDim !== cfg.embeddingDim) {
      throw new Error(
        `embedding dimension changed since last ingest ` +
          `(index is ${tableDim}-d, config is ${cfg.embeddingDim}-d) — ` +
          `run \`qkb ingest --full\` to re-embed the whole vault`,
      );
    }
  }
  const ranked = await runSearch(conn, cfg, provider, query, filters, resolvedLimit, tier);
  return hydrate(conn, ranked);
}
