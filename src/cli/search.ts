/** `search` (BM25), `vsearch` (vector), and `query` (hybrid RRF) commands.
 * Ports the `search`/`vsearch`/`query` commands and `_do_search` from
 * `legacy/python/src/qkb/cli.py`. */
import type { Command } from "commander";
import { getProvider } from "../embed/provider.js";
import { executeSearch } from "../search/service.js";
import { createDownloadProgressRenderer } from "./progress.js";
import {
  action,
  addSearchOptions,
  cfg,
  emit,
  failUsage,
  filtersFromOpts,
  limitFromOpts,
  openDb,
  printContextHint,
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
  // A vector/hybrid search's first call to provider.embedQuery() can trigger
  // the same first-run GGUF download `qkb embed` does (llama provider only)
  // — this is an interactive terminal command, so it gets live progress too
  // (unlike the MCP server; see src/server/mcp.ts's docstring / the
  // provider construction in buildServer(), which deliberately does NOT
  // wire this callback: stderr progress writes would be inappropriate
  // output for an MCP stdio server to emit mid-tool-call).
  const downloadRenderer = tier === "bm25" ? null : createDownloadProgressRenderer();
  const provider =
    tier === "bm25"
      ? null
      : await getProvider(cfgObj, {
          onDownloadProgress: (received, total) => downloadRenderer?.update(received, total),
        });
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
    // executeSearch/buildFilterClause throw SearchValidationError (extends
    // Error) for bad user input (limit < 1, empty filter values, unparseable
    // dates, index rebuild in progress, dimension mismatch) — mirrors cli.py
    // wrapping ValueError in click.UsageError (exit code 2). The
    // `instanceof Error` catch below covers it since SearchValidationError
    // extends Error.
    //
    // downloadRenderer.stop() is called HERE, deliberately not in a
    // `finally` below: failUsage() calls process.exit(2) synchronously, and
    // Node does NOT run a pending `finally` before an explicit
    // process.exit() (verified empirically) — a `finally` here would only
    // ever fire on the success path, leaving a dangling in-place `\r`
    // progress line (no trailing newline) on every error exit, with the
    // next shell prompt landing mid-line. Contrast src/cli/ingest.ts's
    // runEmbed(): its warmup catch does a normal `throw new Error(...)`
    // that propagates up to the `action()` wrapper (./shared.ts), which is
    // what actually calls `process.exit(1)` — by then runEmbed's `finally`
    // has already run as part of ordinary exception unwinding, so that
    // `finally` genuinely is safe.
    downloadRenderer?.stop();
    failUsage(e instanceof Error ? e.message : String(e));
  }
  downloadRenderer?.stop();
  const asJson = Boolean(opts.json);
  const asFiles = Boolean(opts.files);
  emit(results, asJson, asFiles, query, tier);
  // Human output only (issue #14, gap 3) — --json/--files consumers get
  // exactly the documented shape, no extra stderr noise mixed in.
  if (!asJson && !asFiles) {
    printContextHint(conn, query, results.length);
  }
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
