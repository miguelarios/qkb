/**
 * Optional query expansion (#38). Off by default; `[expansion] enabled =
 * true` or `qkb query --expand` turns it on.
 *
 * A small local model rewrites the query into a few variants: `lex` ones
 * (other keywords, run through BM25) and `vec` ones (paraphrases or a
 * hypothetical answer, run through vector search). Their result lists are
 * fused with the original query's, which keeps extra weight. Model, prompt,
 * grammar and sampling follow QMD's fine-tuned expansion model. Any failure
 * falls back to the plain query.
 */
import { parse } from "node:path";
import type { Config } from "../config.js";
import type { DownloadProgressFn } from "../embed/models.js";
import { ensureModel } from "../embed/models.js";
import { words } from "./rerank.js";

export interface QueryVariant {
  /** `lex` goes to BM25, `vec` to vector search. */
  type: "lex" | "vec";
  text: string;
}

export interface QueryExpander {
  expand(query: string): Promise<QueryVariant[]>;
  readonly modelName: string;
  close?(): Promise<void>;
}

/** Deterministic, offline expander for tests: a fixed synonym table, plus a
 * `vec` paraphrase of the query. */
export class FakeExpander implements QueryExpander {
  readonly modelName = "fake-expander";

  constructor(private readonly synonyms: Record<string, string[]> = {}) {}

  async expand(query: string): Promise<QueryVariant[]> {
    const out: QueryVariant[] = [];
    for (const w of words(query)) {
      for (const s of this.synonyms[w] ?? []) {
        out.push({ type: "lex", text: query.toLowerCase().replace(w, s) });
      }
    }
    out.push({ type: "vec", text: `notes about ${query}` });
    return out;
  }
}

const GRAMMAR = `root ::= line+
line ::= type ": " content "\\n"
type ::= "lex" | "vec" | "hyde"
content ::= [^\\n]+`;

const EXPAND_CONTEXT_SIZE = 2048;

/** Parse the model's `type: text` lines. `hyde` (a hypothetical answer) is
 * embedded like any other `vec` variant. Variants that share no word with the
 * query are dropped — they are drift, not rewrites — as are duplicates. */
export function parseVariants(query: string, output: string, max: number): QueryVariant[] {
  const q = new Set(words(query));
  const seen = new Set([query.trim().toLowerCase()]);
  const out: QueryVariant[] = [];
  for (const line of output.split("\n")) {
    const m = /^(lex|vec|hyde):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const text = (m[2] as string).trim();
    const key = text.toLowerCase();
    if (seen.has(key) || !words(text).some((w) => q.has(w))) continue;
    seen.add(key);
    out.push({ type: m[1] === "lex" ? "lex" : "vec", text });
    if (out.length >= max) break;
  }
  return out;
}

interface SessionLike {
  prompt(text: string, options: Record<string, unknown>): Promise<string>;
  resetChatHistory(): void;
}

export class LlamaExpander implements QueryExpander {
  readonly modelName: string;
  private loading:
    | Promise<{ session: SessionLike; grammar: unknown; dispose: () => Promise<void> }>
    | undefined;

  constructor(
    private readonly repo: string,
    private readonly file: string,
    private readonly cacheDir: string,
    private readonly maxVariants: number,
    private readonly onDownloadProgress?: DownloadProgressFn,
  ) {
    this.modelName = parse(file).name;
  }

  private load() {
    this.loading ??= (async () => {
      const modelPath = await ensureModel(
        this.repo,
        this.file,
        this.cacheDir,
        undefined,
        this.onDownloadProgress,
      );
      const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath, gpuLayers: "auto" });
      const context = await model.createContext({
        contextSize: Math.min(model.trainContextSize, EXPAND_CONTEXT_SIZE),
      });
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      const grammar = await llama.createGrammar({ grammar: GRAMMAR });
      return {
        session: session as unknown as SessionLike,
        grammar,
        dispose: async () => {
          await context.dispose();
          await model.dispose();
        },
      };
    })().catch((e: unknown) => {
      this.loading = undefined;
      throw e;
    });
    return this.loading;
  }

  async expand(query: string): Promise<QueryVariant[]> {
    const { session, grammar } = await this.load();
    // Each expansion is independent: no chat history carries over.
    session.resetChatHistory();
    const output = await session.prompt(`/no_think Expand this search query: ${query}`, {
      grammar,
      temperature: 0.7,
      topK: 20,
      topP: 0.8,
      repeatPenalty: { lastTokens: 64, presencePenalty: 0.5 },
      maxTokens: 600,
    });
    return parseVariants(query, output, this.maxVariants);
  }

  async close(): Promise<void> {
    if (!this.loading) return;
    await (await this.loading).dispose();
    this.loading = undefined;
  }
}

export function getExpander(cfg: Config, onDownloadProgress?: DownloadProgressFn): QueryExpander {
  switch (cfg.expansionProvider) {
    case "fake":
      return new FakeExpander();
    case "llama":
      return new LlamaExpander(
        cfg.expansionGgufRepo,
        cfg.expansionGgufFile,
        cfg.modelCacheDir,
        cfg.expansionMaxVariants,
        onDownloadProgress,
      );
    default:
      throw new Error(`unknown expansion provider: ${JSON.stringify(cfg.expansionProvider)}`);
  }
}
