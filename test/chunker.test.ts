import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens } from "../src/ingest/chunker.js";

// Ports legacy/python/tests/test_chunker.py — chunk boundaries and token
// counts must be identical to the Python source (algorithm fidelity: the
// break-point scoring weights, fence-interior tracking, and overlap math in
// src/ingest/chunker.ts are a line-for-line port of
// legacy/python/src/qkb/ingest/chunker.py).
describe("ingest/chunker", () => {
  describe("empty and small documents", () => {
    it("returns [] for empty input", () => {
      expect(chunkText("")).toEqual([]);
    });

    it("returns a single chunk for a short paragraph", () => {
      const chunks = chunkText("Just one short paragraph.");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.index).toBe(0);
      expect(chunks[0]?.text.trim()).toBe("Just one short paragraph.");
    });
  });

  it("prefers heading boundaries", () => {
    const partA = "word ".repeat(380); // ~475 estimated tokens
    const doc = `# Section One\n\n${partA}\n\n# Section Two\n\n${"more ".repeat(380)}`;
    const chunks = chunkText(doc, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The second chunk should begin at (or contain, at its start) the heading.
    const secondChunk = chunks[1];
    expect(secondChunk).toBeDefined();
    const firstLine = secondChunk?.text.split("\n")[0] ?? "";
    const startsWithHeading =
      firstLine.includes("# Section Two") ||
      secondChunk?.text.trimStart().startsWith("# Section Two");
    expect(startsWithHeading).toBe(true);
  });

  it("never splits a code fence", () => {
    const code = `\`\`\`python\n${"x = 1\n".repeat(300)}\`\`\``;
    const doc = `Intro paragraph.\n\n${code}\n\nOutro paragraph.`;
    const chunks = chunkText(doc, 200);
    const fenceChunks = chunks.filter((c) => c.text.includes("```python"));
    expect(fenceChunks.length).toBeGreaterThan(0);
    // Opening fence chunk must also contain the closing fence (kept whole).
    for (const c of fenceChunks) {
      expect((c.text.match(/```/g) ?? []).length).toBe(2);
    }
  });

  it("carries overlap across a hard cut", () => {
    const doc = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i}. ${"filler ".repeat(60)}`,
    ).join("\n\n");
    const chunks = chunkText(doc, 200, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0];
    const second = chunks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const tail = (first?.text.slice(-80) ?? "").trim();
    const head = tail.slice(0, 40);
    expect(head).toBeTruthy();
    expect(second?.text.includes(head)).toBe(true);
  });

  it("assigns sequential indices and correct token counts", () => {
    const doc = Array.from({ length: 6 }, () => "para ".repeat(100)).join("\n\n");
    const chunks = chunkText(doc, 150);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    for (const c of chunks) {
      expect(c.tokenCount).toBe(estimateTokens(c.text));
    }
  });
});
