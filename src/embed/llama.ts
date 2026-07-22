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
 * param in `LlamaCppProvider.__init__`). The real `LlamaEmbeddingContext`
 * doesn't expose `contextSize`/`tokenize`/`detokenize` itself (those live on
 * `.model`, and `contextSize` is a private field on its internal
 * `LlamaContext`) — `loadReal()` below adapts the real object to this
 * richer shape so `embedRaw()`'s truncation logic (see its docstring) works
 * identically against the real context and the test fakes. */
export interface LlamaEmbeddingContextLike {
  getEmbeddingFor(input: string): Promise<LlamaEmbeddingLike>;
  dispose?(): void | Promise<void>;
  /** The token budget `getEmbeddingFor` was created with. The real
   * node-llama-cpp implementation THROWS ("Input is longer than the
   * context size...") instead of truncating when this is exceeded, so
   * `embedRaw()` must never call `getEmbeddingFor` with more than this
   * (minus `EMBEDDING_SAFETY_MARGIN`) many tokens. */
  contextSize: number;
  tokenize(text: string): readonly number[];
  detokenize(tokens: readonly number[]): string;
}

interface DisposableModel {
  dispose(): void | Promise<void>;
}

/** Tokens of slack subtracted from `contextSize` to get the truncation
 * budget: the real `getEmbeddingFor` re-tokenizes whatever string it's
 * given and, if that's under budget, silently prepends a BOS token and/or
 * appends an EOS token when the tokenized input doesn't already end/start
 * with one (see node-llama-cpp's `LlamaEmbeddingContext.getEmbeddingFor` —
 * up to 2 extra tokens). The rest of the margin absorbs the fact that
 * `truncateToContext` below detokenizes a *sliced* token list back to a
 * string, which `getEmbeddingFor` then re-tokenizes from scratch — BPE
 * merge behavior at that new boundary can occasionally produce a token or
 * two more than the slice length. Verified empirically against the real
 * embeddinggemma-300M-Q8_0 GGUF (see ts-dlprogress-report.md's integration
 * section): re-tokenizing a truncated ~20k-word input produced exactly the
 * slice length back, so 8 is a generous, not a bare-minimum, cushion. */
const EMBEDDING_SAFETY_MARGIN = 8;

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
    // Request the context explicitly at the model's own trained size
    // (2048 for embeddinggemma-300M — matches the Python provider's
    // hardcoded `_N_CTX`, legacy/python/src/qkb/embed/local.py) rather than
    // leaving it at node-llama-cpp's default `"auto"`, which adapts to
    // available VRAM and can silently come out SMALLER than trained size.
    // `embedRaw`'s truncation math below needs to know the real ceiling
    // `getEmbeddingFor` will enforce; requesting a specific number makes
    // that ceiling exactly what we asked for, instead of something we'd
    // otherwise have no public way to read back (the real
    // `LlamaEmbeddingContext` doesn't expose `contextSize` — it's a
    // private field on its internal `LlamaContext`). A 2048-token context
    // is a trivial VRAM cost for a 300M-parameter model, so there's no
    // real downside to pinning it.
    //
    // Minor/follow-up: this is uncapped — if [embedding].local_gguf_repo/
    // local_gguf_file is ever pointed at a GGUF with a much larger trained
    // context (e.g. a multi-thousand-token LLM-scale context window
    // instead of embeddinggemma's 2048), requesting that full size as a
    // hard `number` here (vs `"auto"`) could exceed available VRAM.
    // node-llama-cpp's own docs note a hard number "throw[s] an error" in
    // that case rather than degrading — which is a clear, loud failure
    // (not silent corruption), so left as-is for now rather than adding a
    // cap/clamp with no real GGUF to validate it against.
    const contextSize = model.trainContextSize;
    const embeddingContext = await model.createEmbeddingContext({ contextSize });
    return {
      contextSize,
      tokenize: (text) => model.tokenize(text),
      detokenize: (tokens) => model.detokenize(tokens as Parameters<typeof model.detokenize>[0]),
      getEmbeddingFor: (input) => embeddingContext.getEmbeddingFor(input),
      dispose: () => embeddingContext.dispose(),
    };
  }

  /** Truncates `text` to fit `context.contextSize` (minus
   * `EMBEDDING_SAFETY_MARGIN`) tokens, keeping a prefix. No-op when it
   * already fits. Mirrors ollama's `/api/embed` default (`truncate: true`)
   * — the parity baseline the owner's golden-query index was actually
   * built against — rather than node-llama-cpp's real behavior of
   * THROWING on an over-long input (`"Input is longer than the context
   * size..."`), which crashed real `qkb embed --full` runs on vault chunks
   * whose token count (after template application, see below) exceeded
   * the model's 2048-token context.
   *
   * Called from `embedRaw()`, i.e. AFTER `embed()`/`embedQuery()` apply the
   * doc/query template — deliberately, not before: the template adds its
   * own tokens ("title: none | text: ", "task: search result | query: ",
   * etc.), and it's the *templated* string that actually gets tokenized and
   * fed to `getEmbeddingFor`, so truncating the raw chunk text first could
   * still overflow once the template wraps it. Truncating the final,
   * template-applied string is the only point that's guaranteed correct
   * regardless of template length. */
  private truncateToContext(text: string, context: LlamaEmbeddingContextLike): string {
    const tokens = context.tokenize(text);
    const budget = Math.max(0, context.contextSize - EMBEDDING_SAFETY_MARGIN);
    if (tokens.length <= budget) {
      return text;
    }
    return context.detokenize(tokens.slice(0, budget));
  }

  private async embedRaw(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const context = await this.getContext();
    const vectors: number[][] = [];
    for (const input of inputs) {
      const truncated = this.truncateToContext(input, context);
      const embedding = await context.getEmbeddingFor(truncated);
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
