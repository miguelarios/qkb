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

  // Regression for the gpuLayers: -1 bug (src/embed/llama.ts's loadReal()
  // docstring): -1 isn't a value node-llama-cpp v3 recognizes as "offload
  // everything" (that's llama-cpp-python's convention, not this library's),
  // and empirically resolved to 0 layers offloaded — pure CPU inference.
  // LlamaProvider doesn't expose its internal `Llama`/`LlamaModel` objects,
  // so this drives getLlama()/loadModel() directly (the same two calls
  // loadReal() makes) to inspect `llama.gpu` and `model.gpuLayers` for
  // real, on whatever backend is actually available in this environment —
  // skips the assertion (rather than failing) on a machine with no GPU
  // backend at all, where 0 offloaded layers is correct, not a regression.
  it("offloads layers to the GPU when one is available", async () => {
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    const model = await llama.loadModel({
      modelPath: `${process.env.HOME}/.cache/qkb/models/${FILE}`,
      gpuLayers: "auto",
    });
    try {
      console.log(`llama.gpu = ${String(llama.gpu)}, model.gpuLayers = ${model.gpuLayers}`);
      if (llama.gpu) {
        expect(model.gpuLayers).toBeGreaterThan(0);
      }
    } finally {
      await model.dispose();
    }
  }, 120_000);

  // Evidence of the Metal speedup over the prior CPU-band run (owner's
  // production `qkb embed --full`: 3838 chunks in 15m59s at 576% CPU ≈
  // 4 chunks/s under the -1/CPU-only bug). ~100 realistic-length chunk-ish
  // texts (a handful of sentences each, similar order of magnitude to the
  // ~500-token chunk_target_tokens default) through the real doc-template +
  // truncate + embed path, timed end to end (first call pays the one-time
  // model load, same as any real `qkb embed` run).
  it("embeds a batch of realistic-length texts and reports throughput", async () => {
    const provider = new LlamaProvider(REPO, FILE, `${process.env.HOME}/.cache/qkb/models`, DIM);
    try {
      const sentence =
        "The quick brown fox jumps over the lazy dog near the old stone bridge " +
        "while the autumn leaves drift slowly across the quiet, winding path. ";
      const texts = Array.from({ length: 100 }, (_, i) =>
        `Document ${i}: ${sentence.repeat(6)}`.trim(),
      );

      const start = performance.now();
      const vecs = await provider.embed(texts);
      const elapsedMs = performance.now() - start;

      expect(vecs).toHaveLength(100);
      for (const v of vecs) expect(v).toHaveLength(DIM);

      const chunksPerSec = (100 / elapsedMs) * 1000;
      console.log(
        `embedded 100 chunks in ${(elapsedMs / 1000).toFixed(2)}s ` +
          `(${chunksPerSec.toFixed(1)} chunks/s, incl. one-time model load)`,
      );
    } finally {
      provider.close?.();
    }
  }, 120_000);
});
