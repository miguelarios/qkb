/** `ingest` (structural) and `embed` (vectors) commands. Ports `ingest`/
 * `embed` from `legacy/python/src/qkb/cli.py`, including progress rendering,
 * grouped skip reporting, and graceful Ctrl-C.
 *
 * Ctrl-C design (fix round 1 — see ts-task-15-report.md): a SIGINT handler
 * calling `process.exit()` directly cannot reliably run at all during a
 * synchronous, no-real-yield-point loop (structural ingest with the `fake`
 * provider never truly returns to the event loop) — Node just never gets a
 * chance to invoke it until the pipeline call's promise settles, by which
 * point the whole thing has already finished. Fixed by making this
 * cooperative instead of signal-driven-and-abrupt: SIGINT here only calls
 * `AbortController.abort()`; `ingestVault`/`embedPending` (src/ingest/
 * pipeline.ts) do the actual work of yielding to the event loop and checking
 * `signal.aborted` between iterations, so the abort request is guaranteed a
 * chance to be observed regardless of provider/loop synchronicity. Once the
 * pipeline call returns, this checks whether it stopped early and only then
 * prints the abort message and exits 130 — a plain, deterministic
 * post-hoc decision, not a race against when the OS delivers the signal.
 *
 * Unexpected errors from `ingestVault`/`embedPending` are not caught here —
 * they propagate to the `action()` wrapper each command is registered with
 * (see `./shared.ts`), which prints a clean one-line message and exits 1
 * rather than a raw stack trace. */
import { relative, sep } from "node:path";
import type { Command } from "commander";
import { Storage } from "../db/storage.js";
import { getProvider } from "../embed/provider.js";
import { embedPending, ingestVault } from "../ingest/pipeline.js";
import { createProgressRenderer } from "./progress.js";
import { action, cfg, openDb, shorten } from "./shared.js";

export const INGEST_ABORT_MESSAGE = "\nAborted. Re-run `qkb ingest` to continue.";
export const EMBED_ABORT_MESSAGE = "\nAborted. Progress is saved — re-run `qkb embed` to resume.";

/** Prints the command-specific abort message and exits 130 (the standard
 * 128+SIGINT convention) — the "we actually stopped early" half of Ctrl-C
 * handling. Exported standalone so its message/exit-code contract is
 * directly unit-testable without needing a real signal or a real pipeline
 * run (see test/cli.test.ts). */
export function reportAbortAndExit(message: string): never {
  console.log(message);
  process.exit(130);
}

/** Group skips by reason (most-frequent first, ties in first-seen order —
 * a `Map`'s insertion-ordered iteration plus a stable sort both preserve
 * that), then render the cli.py-equivalent summary block: a count line, a
 * `-v`-gated per-file listing, and a hint otherwise. Ports the
 * `Counter`-based block in cli.py's `ingest`. */
export function summarizeSkips(skips: Array<[string, string]>, verbose: boolean): string[] {
  if (skips.length === 0) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const [, reason] of skips) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [`⚠ ${skips.length} note(s) skipped (not searchable):`];
  for (const [reason, n] of byCount) {
    lines.push(`    ${n} × ${reason}`);
  }
  if (verbose) {
    for (const [rel, reason] of skips) {
      lines.push(`      ${reason.padEnd(16)} ${rel}`);
    }
  } else {
    lines.push(
      "  add an `id:` (and a `created:`/`date:`) to include them; `qkb ingest -v` lists them",
    );
  }
  return lines;
}

export async function runIngest(opts: { full?: boolean; verbose?: boolean }): Promise<void> {
  const cfgObj = cfg();
  const conn = openDb(cfgObj);

  const skips: Array<[string, string]> = [];
  const onSkip = (path: string, reason: string): void => {
    const rel = relative(cfgObj.vaultPath, path).split(sep).join("/");
    skips.push([rel, reason]);
  };

  const renderer = createProgressRenderer();
  const onProgress = (done: number, total: number, current: string | null): void => {
    const desc = current === null ? "Indexing" : `Indexing ${shorten(current)}`;
    renderer.tick(done, total, desc);
  };

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  let stats: Awaited<ReturnType<typeof ingestVault>>;
  try {
    stats = await ingestVault(conn, cfgObj, {
      full: opts.full,
      onProgress,
      onSkip,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    renderer.stop();
  }

  if (controller.signal.aborted) {
    reportAbortAndExit(INGEST_ABORT_MESSAGE);
  }

  let summary = `✓ indexed ${stats.indexed}  updated ${stats.updated}  unchanged ${stats.unchanged}`;
  if (stats.deindexed) {
    summary += `  deindexed ${stats.deindexed}`;
  }
  summary += `  (${stats.scanned} scanned)`;
  console.log(summary);

  for (const line of summarizeSkips(skips, Boolean(opts.verbose))) {
    console.log(line);
  }

  const st = new Storage(conn, cfgObj.vaultName).stats();
  const pending = st.chunks - (st.vectors ?? 0);
  if (pending) {
    console.log(
      `${pending} chunk(s) need embedding for semantic search — run qkb embed  ` +
        "(keyword search works now)",
    );
  }
}

export async function runEmbed(opts: { full?: boolean }): Promise<void> {
  const cfgObj = cfg();
  const conn = openDb(cfgObj);

  if (!opts.full) {
    // Check for pending work BEFORE constructing/warming the provider: on a
    // fully-embedded index this is the common case (e.g. `qkb ingest && qkb
    // embed` twice in a row, or a CI/cron re-run). `getProvider()` itself is
    // lazy (see src/embed/llama.ts's docstring — resolving/downloading the
    // GGUF and loading the model are deferred to the first real `embed()`
    // call), but the warmup call just below is exactly that first call, so
    // reaching it unconditionally used to mean every `qkb embed` invocation
    // triggered a model load/download even with nothing to do. Only the
    // no-pending-and-not-`--full` case is safe to skip early — `--full`
    // always needs the provider (it re-embeds everything regardless of
    // `pendingChunks()`), and any actual pending work still goes through
    // `embedPending`'s model/dim consistency guard below exactly as before.
    const storage = new Storage(conn, cfgObj.vaultName);
    if (storage.pendingChunks().length === 0) {
      console.log("✓ all chunks already embedded");
      return;
    }
  }

  const provider = await getProvider(cfgObj);

  console.log("Loading embedding model (first run downloads it)…");
  try {
    await provider.embed(["warmup"]);
  } catch (e) {
    throw new Error(
      `could not load embedding model: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const renderer = createProgressRenderer();
  const onProgress = (done: number, total: number): void => {
    renderer.tick(done, total, "Embedding");
  };

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  let n: number;
  try {
    n = await embedPending(conn, cfgObj, provider, {
      full: opts.full,
      onProgress,
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    renderer.stop();
  }

  if (controller.signal.aborted) {
    reportAbortAndExit(EMBED_ABORT_MESSAGE);
  }

  if (n === 0) {
    console.log("✓ all chunks already embedded");
  } else {
    console.log(`✓ embedded ${n} chunk(s)`);
  }
}

export function registerIngestCommands(program: Command): void {
  program
    .command("ingest")
    .description("Build the keyword index (fast, no model needed). Run `qkb embed` after.")
    .option("--full", "re-chunk every note (e.g. after changing chunk settings)")
    .option("-v, --verbose", "list every skipped note")
    .action(action(runIngest));

  program
    .command("embed")
    .description("Compute vectors for chunks that need them. Resumable — safe to Ctrl-C.")
    .option("--full", "re-embed every chunk (e.g. after changing the model)")
    .action(action(runEmbed));
}
