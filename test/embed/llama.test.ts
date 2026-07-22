import { describe, expect, it, vi } from "vitest";
import type { LlamaEmbeddingContextLike, LlamaEmbeddingLike } from "../../src/embed/llama.js";
import { LlamaProvider } from "../../src/embed/llama.js";
import * as models from "../../src/embed/models.js";

// Mocks the ensureModel seam so the "no context/contextLoader" (real) path
// can be exercised without a network call or a real node-llama-cpp load:
// ensureModel is forced to reject immediately, before loadReal() ever
// reaches `getLlama()`, while still letting the test assert exactly what
// LlamaProvider passed through. Matches the wrap-the-real-export mocking
// pattern already used for getProvider/connect in test/mcp.test.ts.
vi.mock("../../src/embed/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/embed/models.js")>();
  return { ...actual, ensureModel: vi.fn(actual.ensureModel) };
});

// Ports legacy/python/tests/test_local_provider.py. Fully offline: a
// recording fake stands in for the node-llama-cpp embedding context (the
// injection seam), so these pass without downloading or loading a GGUF.
const DIM = 4;
const FILE = "embeddinggemma-300M-Q8_0.gguf";

// Word-level fake tokenizer: each "token" is a word's index into the most
// recently tokenized word list, which detokenize() reads back from — good
// enough to exercise LlamaProvider's truncate-then-embed logic (slice N
// tokens, detokenize, embed) without needing a real tokenizer. contextSize
// defaults large enough that no existing short-input test below is affected.
class RecordingContext {
  dim: number;
  calls: string[][] = [];
  disposed = false;
  contextSize: number;
  private _lastWords: string[] = [];

  constructor(dim = DIM, contextSize = 1000) {
    this.dim = dim;
    this.contextSize = contextSize;
  }

  tokenize(text: string): readonly number[] {
    this._lastWords = text.length === 0 ? [] : text.split(" ");
    return this._lastWords.map((_, i) => i);
  }

  detokenize(tokens: readonly number[]): string {
    return tokens.map((i) => this._lastWords[i]).join(" ");
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
  opts: {
    dim?: number;
    dimension?: number;
    docTemplate?: string;
    queryTemplate?: string;
    contextSize?: number;
  } = {},
) {
  const context = new RecordingContext(opts.dim ?? DIM, opts.contextSize);
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

  it("forwards onDownloadProgress to ensureModel on the real (no context/contextLoader) path", async () => {
    vi.mocked(models.ensureModel).mockClear();
    vi.mocked(models.ensureModel).mockImplementationOnce(() =>
      Promise.reject(new Error("stop before node-llama-cpp")),
    );
    const onDownloadProgress = vi.fn();
    const p = new LlamaProvider("some-org/repo", FILE, "/unused/cache", DIM, {
      onDownloadProgress,
    });

    await expect(p.embed(["a"])).rejects.toThrow("stop before node-llama-cpp");

    expect(models.ensureModel).toHaveBeenCalledTimes(1);
    const call = vi.mocked(models.ensureModel).mock.calls[0];
    expect(call?.[0]).toBe("some-org/repo");
    expect(call?.[1]).toBe(FILE);
    expect(call?.[2]).toBe("/unused/cache");
    // 4th positional arg is the fetchFn (left at its default); the callback
    // is threaded through as the 5th.
    expect(call?.[4]).toBe(onDownloadProgress);
  });

  // Regression: node-llama-cpp's real getEmbeddingFor() THROWS ("Input is
  // longer than the context size...") rather than truncating, unlike
  // ollama's /api/embed (truncate: true by default) which the owner's
  // golden-query baseline was built against. LlamaProvider must truncate
  // before calling getEmbeddingFor so long vault chunks don't blow up
  // `qkb embed --full` (see src/embed/llama.ts's embedRaw()/truncateToContext()
  // docstrings for the exact budget math).
  it("passes input through untouched when it fits the context budget", async () => {
    const { p, context } = makeProvider({ contextSize: 100, docTemplate: "{t}" });
    await p.embed(["short text"]);
    expect(context.calls).toEqual([["short text"]]);
  });

  it("truncates input exceeding the context budget before calling getEmbeddingFor", async () => {
    const { p, context } = makeProvider({ contextSize: 20, docTemplate: "{t}" });
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);

    const vecs = await p.embed([words.join(" ")]);

    expect(vecs).toEqual([Array(DIM).fill(0.1)]); // succeeds instead of throwing
    expect(context.calls.length).toBe(1);
    const sentWords = context.calls[0]?.[0]?.split(" ") ?? [];
    expect(sentWords.length).toBeGreaterThan(0);
    expect(sentWords.length).toBeLessThan(words.length);
    // Truncation keeps a prefix of the original tokens (not a random slice).
    expect(words.slice(0, sentWords.length)).toEqual(sentWords);
  });

  it("truncates a long embedQuery() input the same way", async () => {
    const { p, context } = makeProvider({ contextSize: 20, queryTemplate: "{t}" });
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);

    await p.embedQuery(words.join(" "));

    const sentWords = context.calls[0]?.[0]?.split(" ") ?? [];
    expect(sentWords.length).toBeLessThan(words.length);
    expect(words.slice(0, sentWords.length)).toEqual(sentWords);
  });
});
