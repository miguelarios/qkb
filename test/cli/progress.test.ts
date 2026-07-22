import { describe, expect, it } from "vitest";
import { formatDownloadProgress } from "../../src/cli/progress.js";

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
