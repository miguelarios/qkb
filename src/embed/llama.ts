/**
 * In-process embeddings via node-llama-cpp (GGUF models, Metal-accelerated
 * on Apple Silicon). No resident service: the model lives in RAM only while
 * a qkb process runs.
 *
 * Ports the template application / model-name / laziness semantics of
 * `legacy/python/src/qkb/embed/local.py` (the llama-cpp-python provider
 * this replaces), swapping llama-cpp-python for node-llama-cpp per plan §7.
 * Laziness is stronger here than in the Python original: resolving/
 * downloading the GGUF and loading the model are both deferred to the
 * first `embed`/`embedQuery` call, not done at construction, so
 * `getProvider()` and `modelName` never touch the filesystem or network.
 */
import { parse } from "node:path";
import type { DownloadProgressFn } from "./models.js";
import { ensureModel } from "./models.js";
import { applyTemplate, defaultFormats, validatedTemplate } from "./templates.js";
import type { EmbeddingProvider } from "./types.js";

/** Structural shape of node-llama-cpp's `LlamaEmbedding` we depend on. */
export interface LlamaEmbeddingLike {
  vector: readonly number[];
}

/** Structural shape of node-llama-cpp's `LlamaEmbeddingContext` we depend
 * on — the injection seam for tests (mirrors Python's injectable `llama`
 * param in `LlamaCppProvider.__init__`). */
export interface LlamaEmbeddingContextLike {
  getEmbeddingFor(input: string): Promise<LlamaEmbeddingLike>;
  dispose?(): void | Promise<void>;
}

interface DisposableModel {
  dispose(): void | Promise<void>;
}

export interface LlamaProviderOptions {
  docTemplate?: string | null;
  queryTemplate?: string | null;
  /** A ready-made context — short-circuits real resolution/download/load
   * entirely. The primary test seam for template/dimension/batching tests. */
  context?: LlamaEmbeddingContextLike;
  /** A stand-in for the real resolve+download+load pipeline (ensureModel
   * -> getLlama -> loadModel -> createEmbeddingContext). Lets tests
   * control timing/concurrency and count invocations without touching the
   * filesystem or network. Ignored when `context` is set. */
  contextLoader?: () => Promise<LlamaEmbeddingContextLike>;
  /** Forwarded to `ensureModel` on the real (no `context`/`contextLoader`)
   * path — fired as the GGUF streams down on first use. Never touched at
   * construction time; only `loadReal()` (called lazily from `getContext()`)
   * reads it, so passing it stays I/O-free like the rest of the options. */
  onDownloadProgress?: DownloadProgressFn;
}

export class LlamaProvider implements EmbeddingProvider {
  private readonly _ggufRepo: string;
  private readonly _ggufFile: string;
  private readonly _cacheDir: string;
  private readonly _dim: number;
  private readonly _model: string;
  private readonly _docFmt: string;
  private readonly _queryFmt: string;
  private readonly _contextLoader: (() => Promise<LlamaEmbeddingContextLike>) | undefined;
  private readonly _onDownloadProgress: DownloadProgressFn | undefined;
  private _context: LlamaEmbeddingContextLike | undefined;
  private _contextPromise: Promise<LlamaEmbeddingContextLike> | undefined;
  private _loadedModel: DisposableModel | undefined;

  constructor(
    ggufRepo: string,
    ggufFile: string,
    cacheDir: string,
    dimension: number,
    options: LlamaProviderOptions = {},
  ) {
    // model_name is the GGUF stem (e.g. "embeddinggemma-300M-Q8_0"), NOT
    // the bare model family Ollama reports ("embeddinggemma"): vectors from
    // different runtimes/quantizations are not interchangeable, and the
    // differing name makes the embed pipeline's config guard force a
    // --full re-embed when a machine switches provider.
    this._ggufRepo = ggufRepo;
    this._ggufFile = ggufFile;
    this._cacheDir = cacheDir;
    this._dim = dimension;
    this._model = parse(ggufFile).name;
    const [defaultDocFmt, defaultQueryFmt] = defaultFormats(this._model);
    this._docFmt = validatedTemplate("doc_template", options.docTemplate ?? null) ?? defaultDocFmt;
    this._queryFmt =
      validatedTemplate("query_template", options.queryTemplate ?? null) ?? defaultQueryFmt;
    this._context = options.context;
    this._contextLoader = options.contextLoader;
    this._onDownloadProgress = options.onDownloadProgress;
  }

  get dimension(): number {
    return this._dim;
  }

  get modelName(): string {
    return this._model;
  }

  /**
   * Returns the (possibly not-yet-resolved) embedding context, memoizing
   * the in-flight load so concurrent `embed()`/`embedQuery()` calls before
   * the first load completes share one resolve+download+load instead of
   * each kicking off their own — critical for the real path, where two
   * parallel `ensureModel()` downloads would race on the same `.gguf.part`
   * file. The memo is cleared on failure so a failed load can be retried.
   */
  private getContext(): Promise<LlamaEmbeddingContextLike> {
    if (this._context) {
      return Promise.resolve(this._context);
    }
    if (!this._contextPromise) {
      const loader = this._contextLoader ?? (() => this.loadReal());
      this._contextPromise = loader()
        .then((context) => {
          this._context = context;
          return context;
        })
        .catch((e: unknown) => {
          this._contextPromise = undefined;
          throw e;
        });
    }
    return this._contextPromise;
  }

  private async loadReal(): Promise<LlamaEmbeddingContextLike> {
    const modelPath = await ensureModel(
      this._ggufRepo,
      this._ggufFile,
      this._cacheDir,
      undefined,
      this._onDownloadProgress,
    );
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath, gpuLayers: -1 });
    this._loadedModel = model;
    return model.createEmbeddingContext();
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const context = await this.getContext();
    const vectors: number[][] = [];
    for (const input of inputs) {
      const embedding = await context.getEmbeddingFor(input);
      const v = Array.from(embedding.vector);
      if (v.length !== this._dim) {
        throw new Error(
          `Model '${this._model}' returned dimension ${v.length}, config says ${this._dim}. Fix [embedding].dimension.`,
        );
      }
      vectors.push(v);
    }
    return vectors;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedRaw(texts.map((t) => applyTemplate(this._docFmt, t)));
  }

  async embedQuery(query: string): Promise<number[]> {
    const vectors = await this.embedRaw([applyTemplate(this._queryFmt, query)]);
    const [v] = vectors;
    if (v === undefined) {
      throw new Error("embedQuery: no vector returned");
    }
    return v;
  }

  /** Free the model. The MCP server duck-types close() on shutdown. Fires
   * disposal without awaiting, matching the interface's synchronous
   * `close?(): void`. `dispose()` returns a Promise on the real
   * node-llama-cpp objects; a rejection there must not become an
   * unhandled rejection that can crash the process, so it's swallowed —
   * there's nothing further close() could do with it anyway. */
  close(): void {
    void Promise.resolve(this._context?.dispose?.()).catch(() => {});
    void Promise.resolve(this._loadedModel?.dispose()).catch(() => {});
  }
}
