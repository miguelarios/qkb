/**
 * Embedding provider interface + dispatch.
 *
 * Ported from `legacy/python/src/qkb/embed/base.py` (the `EmbeddingProvider`
 * Protocol) and `legacy/python/src/qkb/embed/__init__.py` (`get_provider`
 * dispatch). Plan §7: the TS rewrite drops Python's `local`/`fastembed`/
 * `gguf` split in favor of a single always-installed `llama` provider
 * (node-llama-cpp + Metal) as the default.
 */
import type { Config } from "../config.js";
import { FakeProvider } from "./fake.js";
import { LlamaProvider } from "./llama.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { EmbeddingProvider } from "./types.js";

export type { EmbeddingProvider } from "./types.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";

export async function getProvider(cfg: Config): Promise<EmbeddingProvider> {
  switch (cfg.embeddingProvider) {
    case "fake":
      return new FakeProvider(cfg.embeddingDim);
    case "llama":
      return new LlamaProvider(
        cfg.localGgufRepo,
        cfg.localGgufFile,
        cfg.modelCacheDir,
        cfg.embeddingDim,
        {
          docTemplate: cfg.embeddingDocTemplate,
          queryTemplate: cfg.embeddingQueryTemplate,
        },
      );
    case "ollama":
      return new OllamaProvider(cfg.ollamaHost, cfg.embeddingModel, cfg.embeddingDim, {
        docTemplate: cfg.embeddingDocTemplate,
        queryTemplate: cfg.embeddingQueryTemplate,
      });
    case "openai":
      return new OpenAIProvider(
        cfg.openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL,
        cfg.openaiApiKey,
        cfg.embeddingModel,
        cfg.embeddingDim,
        { docTemplate: cfg.embeddingDocTemplate, queryTemplate: cfg.embeddingQueryTemplate },
      );
    default:
      throw new Error(`unknown embedding provider: ${JSON.stringify(cfg.embeddingProvider)}`);
  }
}
