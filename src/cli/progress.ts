/** TTY progress bar rendering for `ingest`/`embed`, backed by `cli-progress`.
 *
 * Ports the *behavior* of cli.py's `rich.progress.Progress` (spinner + bar +
 * M/N count + elapsed time) — the library differs (rich vs cli-progress) but
 * the on-screen contract (a live bar with current counts and, for ingest,
 * the current file) is the same.
 *
 * Non-TTY degrade: when stdout isn't a terminal (piped output, or a
 * subprocess under test), rendering ANSI cursor/bar escape sequences would
 * just be garbage bytes in the captured output, so this renders nothing at
 * all in that case — every command that uses a `ProgressRenderer` also
 * prints a plain-text final summary line, which is the only feedback
 * non-interactive callers get (matches how most CLIs — and Python's own
 * rich `Console` — auto-detect non-terminal output and suppress
 * animation).
 */
import cliProgress from "cli-progress";
import { humanSize } from "./shared.js";

export interface ProgressRenderer {
  tick(done: number, total: number, description: string): void;
  stop(): void;
}

const NOOP_RENDERER: ProgressRenderer = {
  tick() {
    // no-op: non-TTY output — see module docstring
  },
  stop() {
    // no-op
  },
};

export function createProgressRenderer(): ProgressRenderer {
  if (process.stdout.isTTY !== true) {
    return NOOP_RENDERER;
  }
  const bar = new cliProgress.SingleBar(
    {
      format: "{description} [{bar}] {value}/{total} | {duration_formatted}",
      hideCursor: true,
      clearOnComplete: true,
      stream: process.stdout,
    },
    cliProgress.Presets.shades_classic,
  );
  let started = false;
  return {
    tick(done, total, description) {
      if (!started) {
        bar.start(total, done, { description });
        started = true;
      } else {
        bar.setTotal(total);
        bar.update(done, { description });
      }
    },
    stop() {
      if (started) {
        bar.stop();
      }
    },
  };
}

/** Pure formatter for a single download-progress line — the thing that
 * changes on every tick, kept separate from the TTY plumbing below so it's
 * directly unit-testable. Mirrors the "MB / MB (pct%)" shape when the
 * server sent `content-length`; falls back to a running byte counter
 * ("N MB downloaded") when it didn't (or sent something bogus). */
export function formatDownloadProgress(receivedBytes: number, totalBytes: number | null): string {
  if (totalBytes === null || totalBytes <= 0) {
    return `${humanSize(receivedBytes)} downloaded`;
  }
  const pct = Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
  return `${humanSize(receivedBytes)} / ${humanSize(totalBytes)} (${pct}%)`;
}

export interface DownloadProgressRenderer {
  update(receivedBytes: number, totalBytes: number | null): void;
  stop(): void;
}

const NOOP_DOWNLOAD_RENDERER: DownloadProgressRenderer = {
  update() {
    // no-op: non-TTY output — see module docstring
  },
  stop() {
    // no-op
  },
};

/** Minimum time between rendered updates — `onDownloadProgress` fires once
 * per network chunk (can be hundreds/sec on a fast link), so this is the
 * "consumer throttles rendering" half of that contract. */
const DOWNLOAD_RENDER_THROTTLE_MS = 100;

/** Live single-line renderer for the first-run GGUF download
 * (`onDownloadProgress` in src/embed/models.ts / src/embed/llama.ts) — the
 * only progress feedback for a ~310 MB fetch that otherwise sits silent for
 * minutes. Renders on stderr (matching the plain "downloading..."/"model
 * cached" lines already printed by `ensureModel`, which this complements
 * rather than replaces — those remain the only feedback in the non-TTY
 * case). Writes an in-place `\r`-updated line while total bytes is known,
 * ensuring a trailing newline is flushed the moment the transfer completes
 * (`receivedBytes >= totalBytes`) so it never collides with `ensureModel`'s
 * subsequent "model cached" line. Non-TTY: NOOP, same rationale as
 * `createProgressRenderer` above. */
export function createDownloadProgressRenderer(): DownloadProgressRenderer {
  if (process.stderr.isTTY !== true) {
    return NOOP_DOWNLOAD_RENDERER;
  }
  let lastLineLength = 0;
  let inLine = false;
  let lastRenderAt = 0;

  const writeLine = (text: string): void => {
    const pad = lastLineLength > text.length ? " ".repeat(lastLineLength - text.length) : "";
    process.stderr.write(`\r${text}${pad}`);
    lastLineLength = text.length;
    inLine = true;
  };
  const finish = (): void => {
    if (inLine) {
      process.stderr.write("\n");
      inLine = false;
      lastLineLength = 0;
    }
  };

  return {
    update(receivedBytes, totalBytes) {
      const complete = totalBytes !== null && totalBytes > 0 && receivedBytes >= totalBytes;
      const now = Date.now();
      if (!complete && now - lastRenderAt < DOWNLOAD_RENDER_THROTTLE_MS) {
        return;
      }
      lastRenderAt = now;
      writeLine(`qkb: ${formatDownloadProgress(receivedBytes, totalBytes)}`);
      if (complete) {
        finish();
      }
    },
    stop: finish,
  };
}
