import { describe, expect, it } from "vitest";
import type { LlamaEmbeddingContextLike, LlamaEmbeddingLike } from "../../src/embed/llama.js";
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

  it("close() swallows a rejecting dispose() without an unhandled rejection", async () => {
    const context = new RecordingContext();
    context.dispose = () => Promise.reject(new Error("dispose failed"));
    const p = new LlamaProvider("unused/repo", FILE, "/unused/cache", DIM, { context });
    expect(() => p.close()).not.toThrow();
    // Give the microtask queue a chance to surface an unhandled rejection —
    // without the fix, this would flag as a test failure via Vitest's
    // unhandled-rejection handling.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("shares one in-flight model load across concurrent embed()/embedQuery() calls", async () => {
    let loadCalls = 0;
    let resolveLoad!: (context: LlamaEmbeddingContextLike) => void;
    const deferred = new Promise<LlamaEmbeddingContextLike>((resolve) => {
      resolveLoad = resolve;
    });
    const contextLoader = () => {
      loadCalls++;
      return deferred;
    };
    const p = new LlamaProvider("unused/repo", FILE, "/unused/cache", DIM, { contextLoader });

    // Two concurrent calls before the (slow) load resolves must not each
    // kick off their own resolve/download/load — they should share one
    // in-flight load (regression test for the first-use race: two parallel
    // ensureModel() downloads racing on the same .part path).
    const p1 = p.embed(["a"]);
    const p2 = p.embedQuery("b");
    resolveLoad(new RecordingContext());
    const [v1, v2] = await Promise.all([p1, p2]);

    expect(loadCalls).toBe(1);
    expect(v1).toEqual([Array(DIM).fill(0.1)]);
    expect(v2).toEqual(Array(DIM).fill(0.1));
  });

  it("clears the failed load memo so a subsequent embed can retry", async () => {
    let loadCalls = 0;
    const contextLoader = () => {
      loadCalls++;
      if (loadCalls === 1) {
        return Promise.reject(new Error("network died"));
      }
      return Promise.resolve(new RecordingContext());
    };
    const p = new LlamaProvider("unused/repo", FILE, "/unused/cache", DIM, { contextLoader });

    await expect(p.embed(["a"])).rejects.toThrow(/network died/);
    const vecs = await p.embed(["a"]);

    expect(loadCalls).toBe(2);
    expect(vecs).toEqual([Array(DIM).fill(0.1)]);
  });
});
