/** `ingest` (structural) and `embed` (vectors) commands. Ports `ingest`/
 * `embed` from `legacy/python/src/qkb/cli.py`, including progress rendering,
 * grouped skip reporting, and graceful Ctrl-C.
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
import { createProgressRenderer, type ProgressRenderer } from "./progress.js";
import { action, cfg, openDb, shorten } from "./shared.js";

export const INGEST_ABORT_MESSAGE = "\nAborted. Re-run `qkb ingest` to continue.";
export const EMBED_ABORT_MESSAGE = "\nAborted. Progress is saved — re-run `qkb embed` to resume.";

/** Builds the SIGINT handler `ingest`/`embed` register for the duration of
 * the pipeline call: stop the progress renderer (so a live bar doesn't
 * leave a half-drawn line), print the command-specific abort message, exit
 * 130 (the standard 128+SIGINT convention). Exported standalone — not
 * inlined into `runIngest`/`runEmbed` — so its message/exit-code contract
 * is directly unit-testable without needing to actually deliver a signal
 * (see test/cli.test.ts: true mid-loop interruption isn't reliably
 * testable here — both `ingestVault`'s structural pass and the fake
 * provider's `embed()` are fully synchronous, so there is no real event-loop
 * yield point during a run for an OS signal to land on; this is a Node
 * execution-model constraint, not a gap in this handler). */
export function makeAbortHandler(message: string, renderer: ProgressRenderer): () => void {
  return () => {
    renderer.stop();
    console.log(message);
    process.exit(130);
  };
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

  const onSigint = makeAbortHandler(INGEST_ABORT_MESSAGE, renderer);
  process.on("SIGINT", onSigint);

  let stats: Awaited<ReturnType<typeof ingestVault>>;
  try {
    stats = await ingestVault(conn, cfgObj, { full: opts.full, onProgress, onSkip });
  } finally {
    process.off("SIGINT", onSigint);
    renderer.stop();
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

  const onSigint = makeAbortHandler(EMBED_ABORT_MESSAGE, renderer);
  process.on("SIGINT", onSigint);

  let n: number;
  try {
    n = await embedPending(conn, cfgObj, provider, { full: opts.full, onProgress });
  } finally {
    process.off("SIGINT", onSigint);
    renderer.stop();
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
