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
});
