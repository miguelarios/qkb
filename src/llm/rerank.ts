/**
 * Optional cross-encoder reranking (#37). Off by default; `[rerank] enabled
 * = true` or `qkb query --rerank` turns it on.
 *
 * A reranker reads the query and a candidate's text together and scores how
 * well the text answers the query — slower than BM25/vector retrieval, so it
 * only re-scores the top `[rerank] candidates` hybrid hits. The default model
 * is the same local GGUF QMD uses (Qwen3-Reranker-0.6B), run in-process by
 * node-llama-cpp; nothing leaves the machine.
 */
import { parse } from "node:path";
import type { Config } from "../config.js";
import type { DownloadProgressFn } from "../embed/models.js";
import { ensureModel } from "../embed/models.js";

export interface Reranker {
  /** Relevance of each doc to `query`, in [0, 1], same order as `docs`. */
  rank(query: string, docs: string[]): Promise<number[]>;
  readonly modelName: string;
  close?(): Promise<void>;
}

const WORD = /[\p{L}\p{N}]+/gu;

export function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 1);
}

/** Deterministic, offline reranker for tests: the share of query words the
 * doc contains. */
export class FakeReranker implements Reranker {
  readonly modelName = "fake-reranker";

  async rank(query: string, docs: string[]): Promise<number[]> {
    const q = new Set(words(query));
    return docs.map((d) => {
      if (q.size === 0) return 0;
      const have = new Set(words(d));
      return [...q].filter((w) => have.has(w)).length / q.size;
    });
  }
}

/** Structural shape of node-llama-cpp's `LlamaRankingContext` we use. */
interface RankingContextLike {
  rankAll(query: string, documents: string[]): Promise<number[]>;
  dispose(): Promise<void>;
}

interface ModelLike {
  tokenize(text: string): readonly number[];
  detokenize(tokens: readonly number[]): string;
  dispose(): Promise<void>;
}

/** Context size for reranking. Candidates are passages, not whole notes. */
const RERANK_CONTEXT_SIZE = 2048;
/** Tokens reserved for the reranker's prompt template (QMD's figure). */
const TEMPLATE_OVERHEAD = 512;

export class LlamaReranker implements Reranker {
  readonly modelName: string;
  private loading: Promise<{ ctx: RankingContextLike; model: ModelLike }> | undefined;

  constructor(
    private readonly repo: string,
    private readonly file: string,
    private readonly cacheDir: string,
    private readonly onDownloadProgress?: DownloadProgressFn,
  ) {
    this.modelName = parse(file).name;
  }

  private load(): Promise<{ ctx: RankingContextLike; model: ModelLike }> {
    this.loading ??= (async () => {
      const modelPath = await ensureModel(
        this.repo,
        this.file,
        this.cacheDir,
        undefined,
        this.onDownloadProgress,
      );
      const { getLlama } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath, gpuLayers: "auto" });
      const ctx = await model.createRankingContext({
        contextSize: Math.min(model.trainContextSize, RERANK_CONTEXT_SIZE),
      });
      return { ctx, model: model as unknown as ModelLike };
    })().catch((e: unknown) => {
      this.loading = undefined;
      throw e;
    });
    return this.loading;
  }

  async rank(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return [];
    const { ctx, model } = await this.load();
    // The ranking context throws on over-long input instead of truncating.
    const budget = Math.max(
      64,
      RERANK_CONTEXT_SIZE - TEMPLATE_OVERHEAD - model.tokenize(query).length,
    );
    const fitted = docs.map((d) => {
      const tokens = model.tokenize(d);
      return tokens.length <= budget ? d : model.detokenize(tokens.slice(0, budget));
    });
    // Identical passages (duplicated notes, templates) are scored once.
    const unique = [...new Set(fitted)];
    const scores = await ctx.rankAll(query, unique);
    const byText = new Map(unique.map((t, i) => [t, scores[i] ?? 0]));
    return fitted.map((t) => byText.get(t) ?? 0);
  }

  async close(): Promise<void> {
    if (!this.loading) return;
    const { ctx, model } = await this.loading;
    await ctx.dispose();
    await model.dispose();
    this.loading = undefined;
  }
}

export function getReranker(cfg: Config, onDownloadProgress?: DownloadProgressFn): Reranker {
  switch (cfg.rerankProvider) {
    case "fake":
      return new FakeReranker();
    case "llama":
      return new LlamaReranker(
        cfg.rerankGgufRepo,
        cfg.rerankGgufFile,
        cfg.modelCacheDir,
        onDownloadProgress,
      );
    default:
      throw new Error(`unknown rerank provider: ${JSON.stringify(cfg.rerankProvider)}`);
  }
}

/**
 * Blend retrieval rank with the reranker's score, position-aware (QMD's
 * scheme): the top of the fused list is trusted more, so a confident
 * reranker can lift a deep candidate but can't casually bury an exact hit.
 * `rrfRank` is 1-based.
 */
export function blendScore(rrfRank: number, rerankScore: number): number {
  const w = rrfRank <= 3 ? 0.75 : rrfRank <= 10 ? 0.6 : 0.4;
  return w * (1 / rrfRank) + (1 - w) * rerankScore;
}
