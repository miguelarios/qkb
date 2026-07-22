import { describe, expect, it } from "vitest";
import { LlamaProvider } from "../../src/embed/llama.js";

// Ports legacy/python/tests/test_local_provider_integration.py. Real
// llama.cpp inference: downloads the ~310MB GGUF to ~/.cache/qkb/models on
// first run and loads it via node-llama-cpp/Metal. Never run in CI — only
// via `npm run test:integration` (QKB_INTEGRATION=1).
const REPO = "ggml-org/embeddinggemma-300M-GGUF";
const FILE = "embeddinggemma-300M-Q8_0.gguf";
const DIM = 768;

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
}

describe("embed/llama integration (real model)", () => {
  it("ranks a relevant document over an off-topic one", async () => {
    const provider = new LlamaProvider(REPO, FILE, `${process.env.HOME}/.cache/qkb/models`, DIM);
    try {
      const vecs = await provider.embed([
        "the quick brown fox",
        "totally different topic: sqlite chunking",
      ]);
      const q = await provider.embedQuery("fast animal jumping");
      expect(vecs).toHaveLength(2);
      for (const v of vecs) expect(v).toHaveLength(DIM);
      expect(q).toHaveLength(DIM);

      const [foxVec, sqliteVec] = vecs as [number[], number[]];
      expect(dot(q, foxVec)).toBeGreaterThan(dot(q, sqliteVec));
    } finally {
      provider.close?.();
    }
  }, 120_000);

  // Regression for the production crash this integration suite's absence
  // let ship: the real node-llama-cpp getEmbeddingFor() THROWS ("Input is
  // longer than the context size...") on input over embeddinggemma's
  // 2048-token trained context — the fake-context unit tests in
  // test/embed/llama.test.ts prove the truncate-before-embed *logic*, but
  // only a real model load proves the real tokenizer/detokenizer round
  // trip and the real context actually created stay under that ceiling.
  // 20k words of filler tokenizes to roughly 5-6x that many GGUF tokens
  // (see the probe run recorded in ts-dlprogress-report.md), comfortably
  // exceeding the 2048 budget without a truncate fix.
  it("embeds a deliberately over-long input instead of throwing", async () => {
    const provider = new LlamaProvider(REPO, FILE, `${process.env.HOME}/.cache/qkb/models`, DIM);
    try {
      const overLong = Array.from({ length: 20_000 }, (_, i) => `filler${i}`).join(" ");
      const vecs = await provider.embed([overLong]);
      expect(vecs).toHaveLength(1);
      expect(vecs[0]).toHaveLength(DIM);
      expect(vecs[0]?.some((x) => Number.isFinite(x))).toBe(true);
    } finally {
      provider.close?.();
    }
  }, 120_000);
});
