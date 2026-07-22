import { describe, expect, it } from "vitest";
import { createDownloadProgressRenderer, formatDownloadProgress } from "../../src/cli/progress.js";

// Pure formatting only — the TTY-driven renderer around it isn't tested here
// (see src/cli/progress.ts's module docstring for why: non-TTY output must
// stay ANSI-free, and there's no useful way to assert live terminal
// rendering from a unit test).
describe("cli/progress formatDownloadProgress", () => {
  it("shows received/total in human-readable units with a percentage when total is known", () => {
    expect(formatDownloadProgress(150 * 1024 * 1024, 300 * 1024 * 1024)).toBe(
      "150.0 MB / 300.0 MB (50%)",
    );
  });

  it("floors a fractional percentage", () => {
    expect(formatDownloadProgress(1, 3)).toBe("1 B / 3 B (33%)");
  });

  it("caps the percentage at 100 when received exceeds total", () => {
    expect(formatDownloadProgress(400 * 1024 * 1024, 300 * 1024 * 1024)).toBe(
      "400.0 MB / 300.0 MB (100%)",
    );
  });

  it("falls back to a bytes-only counter when total is null", () => {
    expect(formatDownloadProgress(42 * 1024 * 1024, null)).toBe("42.0 MB downloaded");
  });

  it("falls back to a bytes-only counter when total is zero or negative", () => {
    expect(formatDownloadProgress(10, 0)).toBe("10 B downloaded");
  });
});

// The "stop() contract" src/cli/search.ts's doSearch() relies on: since
// failUsage() calls process.exit(2) synchronously and Node does not run a
// pending `finally` before that (see search.ts's docstring on its catch
// block), doSearch() now calls `downloadRenderer.stop()` explicitly from
// two different call sites (the catch, right before failUsage; and after
// the try block, for the success path) rather than a single `finally`.
// stop() being safe to call in every reachable state — never started,
// after updates, called more than once — is what makes that restructuring
// safe. The TTY-specific rendering (the actual `\r`-line/newline bytes
// written) still isn't unit-tested here, matching the rest of this file —
// only the NOOP (non-TTY) renderer is reachable under vitest's default
// non-interactive stdout/stderr, which is the same renderer real CLI runs
// get under a piped/subprocess or CI environment.
describe("cli/progress createDownloadProgressRenderer stop() contract", () => {
  it("is safe to call before any update()", () => {
    const renderer = createDownloadProgressRenderer();
    expect(() => renderer.stop()).not.toThrow();
  });

  it("is safe to call more than once in a row", () => {
    const renderer = createDownloadProgressRenderer();
    renderer.update(10, 100);
    expect(() => renderer.stop()).not.toThrow();
    expect(() => renderer.stop()).not.toThrow();
  });
});
