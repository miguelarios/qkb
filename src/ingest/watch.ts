/** Keep the index fresh while a long-running process (the MCP server, or
 * `qkb watch`) is up: re-run the incremental ingest + embed on a timer.
 *
 * A timer, not filesystem events, is the baseline on purpose: sync clients
 * write through temp-file renames, and bind/network mounts often don't
 * deliver inotify events at all. The content-hash fast path makes a
 * no-change pass cheap, so polling every few minutes costs little.
 *
 * Runs never overlap: the next one is scheduled only after the previous one
 * finishes, and `runNow()` joins a run already in flight. A failed run is
 * reported through `onError` and the loop keeps going — one bad pass (a
 * vault briefly unmounted, the embedding host down) must not take the
 * server with it.
 */

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { IngestStats } from "../types.js";
import { embedPending, ingestVault } from "./pipeline.js";

export interface ReindexResult {
  stats: IngestStats;
  /** Chunks embedded this pass (0 when no provider was given). */
  embedded: number;
}

/** One incremental pass: structural ingest, then embed whatever is pending.
 * With `provider` null only the keyword index is refreshed. */
export async function reindexOnce(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider | null,
): Promise<ReindexResult> {
  const stats = await ingestVault(conn, cfg);
  const embedded = provider !== null ? await embedPending(conn, cfg, provider) : 0;
  return { stats, embedded };
}

export interface WatchOptions {
  /** Seconds between the end of one run and the start of the next. */
  intervalSec: number;
  /** Run once immediately on start (default true). */
  runOnStart?: boolean;
  onRun?: (result: ReindexResult) => void;
  onError?: (error: unknown) => void;
}

export interface Watcher {
  /** Run a pass now (or join the one in flight) and resolve with its result;
   * resolves null if that pass failed. */
  runNow(): Promise<ReindexResult | null>;
  /** Stop scheduling passes and wait for an in-flight one to finish. */
  stop(): Promise<void>;
}

export function startWatch(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider | null,
  options: WatchOptions,
): Watcher {
  const { intervalSec, runOnStart = true, onRun, onError } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ReindexResult | null> | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runNow();
    }, intervalSec * 1000);
    // Never keep the process alive just for the next re-index.
    timer.unref();
  };

  const runNow = (): Promise<ReindexResult | null> => {
    if (inFlight) return inFlight;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inFlight = (async () => {
      try {
        const result = await reindexOnce(conn, cfg, provider);
        onRun?.(result);
        return result;
      } catch (e) {
        onError?.(e);
        return null;
      } finally {
        inFlight = null;
        schedule();
      }
    })();
    return inFlight;
  };

  if (runOnStart) {
    void runNow();
  } else {
    schedule();
  }

  return {
    runNow,
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
  };
}

/** Human one-liner for a pass, or null when nothing changed (so an idle
 * server's log stays quiet). */
export function describeRun(r: ReindexResult): string | null {
  const s = r.stats;
  if (s.indexed + s.updated + s.deindexed + r.embedded === 0) return null;
  return (
    `re-index: indexed ${s.indexed}  updated ${s.updated}  deindexed ${s.deindexed}` +
    `  embedded ${r.embedded}  (${s.scanned} scanned)`
  );
}
