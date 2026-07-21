import { describe, expect, it } from "vitest";
import type { LlamaEmbeddingLike } from "../../src/embed/llama.js";
import { LlamaProvider } from "../../src/embed/llama.js";

// Ports legacy/python/tests/test_local_provider.py. Fully offline: a
// recording fake stands in for the node-llama-cpp embedding context (the
// injection seam), so these pass without downloading or loading a GGUF.
const DIM = 4;
const FILE = "embeddinggemma-300M-Q8_0.gguf";

class RecordingContext {
  dim: number;
  calls: string[][] = [];
  disposed = false;

  constructor(dim = DIM) {
    this.dim = dim;
  }

  async getEmbeddingFor(text: string): Promise<LlamaEmbeddingLike> {
    this.calls.push([text]);
    return { vector: Array(this.dim).fill(0.1) };
  }

  dispose(): void {
    this.disposed = true;
  }
}

function makeProvider(
  opts: { dim?: number; dimension?: number; docTemplate?: string; queryTemplate?: string } = {},
) {
  const context = new RecordingContext(opts.dim ?? DIM);
  const p = new LlamaProvider("unused/repo", FILE, "/unused/cache", opts.dimension ?? DIM, {
    context,
    docTemplate: opts.docTemplate,
    queryTemplate: opts.queryTemplate,
  });
  return { p, context };
}

describe("embed/llama", () => {
  it("derives modelName from the GGUF stem", () => {
    const { p } = makeProvider();
    expect(p.modelName).toBe("embeddinggemma-300M-Q8_0");
    expect(p.dimension).toBe(DIM);
  });

  it("applies the embeddinggemma doc template on embed", async () => {
    const { p, context } = makeProvider();
    const vecs = await p.embed(["alpha", "beta"]);
    expect(context.calls).toEqual([["title: none | text: alpha"], ["title: none | text: beta"]]);
    expect(vecs).toEqual([Array(DIM).fill(0.1), Array(DIM).fill(0.1)]);
  });

  it("applies the embeddinggemma query template on embedQuery", async () => {
    const { p, context } = makeProvider();
    const vec = await p.embedQuery("find things");
    expect(context.calls).toEqual([["task: search result | query: find things"]]);
    expect(vec).toEqual(Array(DIM).fill(0.1));
  });

  it("lets explicit templates override the heuristic", async () => {
    const { p, context } = makeProvider({ docTemplate: "doc: {t}", queryTemplate: "q: {t}" });
    await p.embed(["x"]);
    await p.embedQuery("y");
    expect(context.calls).toEqual([["doc: x"], ["q: y"]]);
  });

  it("rejects an invalid template at construction", () => {
    expect(
      () =>
        new LlamaProvider("unused/repo", FILE, "/unused/cache", DIM, {
          context: new RecordingContext(),
          docTemplate: "no placeholder",
        }),
    ).toThrow(/doc_template/);
  });

  it("raises on a dimension mismatch", async () => {
    const { p } = makeProvider({ dim: DIM + 1 });
    await expect(p.embed(["alpha"])).rejects.toThrow(/dimension/);
  });

  it("returns [] for an empty batch without touching the context", async () => {
    const { p, context } = makeProvider();
    expect(await p.embed([])).toEqual([]);
    expect(context.calls).toEqual([]);
  });

  it("close() disposes the injected context", () => {
    const { p, context } = makeProvider();
    p.close?.();
    expect(context.disposed).toBe(true);
  });
});
