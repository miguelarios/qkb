/** `search` (BM25), `vsearch` (vector), and `query` (hybrid RRF) commands.
 * Ports the `search`/`vsearch`/`query` commands and `_do_search` from
 * `legacy/python/src/qkb/cli.py`. */
import type { Command } from "commander";
import { getProvider } from "../embed/provider.js";
import { executeSearch } from "../search/service.js";
import {
  action,
  addSearchOptions,
  cfg,
  emit,
  failUsage,
  filtersFromOpts,
  limitFromOpts,
  openDb,
  type SearchOpts,
} from "./shared.js";

async function doSearch(
  tier: "bm25" | "vector" | "hybrid",
  query: string,
  opts: SearchOpts,
  rerank = false,
): Promise<void> {
  const cfgObj = cfg();
  if (rerank) {
    // Ports cli.py's `_do_search`: click.echo(..., err=True); sys.exit(2) —
    // printed verbatim, no "Error:" prefix, before any DB/provider work.
    console.error("re-ranking not configured (Phase 2)");
    process.exit(2);
  }
  const conn = openDb(cfgObj);
  const provider = tier === "bm25" ? null : await getProvider(cfgObj);
  let results: Awaited<ReturnType<typeof executeSearch>>;
  try {
    results = await executeSearch(
      conn,
      cfgObj,
      provider,
      query,
      filtersFromOpts(opts),
      limitFromOpts(opts),
      tier,
    );
  } catch (e) {
    // executeSearch/buildFilterClause throw plain Error for bad user input
    // (limit < 1, empty filter values, unparseable dates, index rebuild in
    // progress, dimension mismatch) — mirrors cli.py wrapping ValueError in
    // click.UsageError (exit code 2).
    failUsage(e instanceof Error ? e.message : String(e));
  }
  emit(results, Boolean(opts.json), Boolean(opts.files));
}

export function registerSearchCommands(program: Command): void {
  addSearchOptions(
    program.command("search").description("Tier 1: BM25 keyword search").argument("<query>"),
  ).action(
    action(async (query: string, opts: SearchOpts) => {
      await doSearch("bm25", query, opts);
    }),
  );

  addSearchOptions(
    program.command("vsearch").description("Tier 2: vector semantic search").argument("<query>"),
  ).action(
    action(async (query: string, opts: SearchOpts) => {
      await doSearch("vector", query, opts);
    }),
  );

  addSearchOptions(
    program
      .command("query")
      .description("Tier 3: hybrid BM25 + vector with RRF fusion")
      .argument("<query>")
      .option("--rerank", "re-ranking (not yet configured)"),
  ).action(
    action(async (query: string, opts: SearchOpts & { rerank?: boolean }) => {
      await doSearch("hybrid", query, opts, Boolean(opts.rerank));
    }),
  );
}
