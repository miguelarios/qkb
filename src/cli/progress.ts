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
