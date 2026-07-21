import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { FakeProvider } from "../../src/embed/fake.js";
import { LlamaProvider } from "../../src/embed/llama.js";
import { OllamaProvider } from "../../src/embed/ollama.js";
import { OpenAIProvider } from "../../src/embed/openai.js";
import { getProvider } from "../../src/embed/provider.js";

// Ports legacy/python/tests/test_embed.py's get_provider dispatch tests.
// FastEmbedProvider/'local'/'gguf' don't port: the plan replaces that
// ONNX/optional-extra split with a single always-installed `llama` default
// provider (docs/plans/2026-07-20-typescript-rewrite.md §7).
function baseConfig(overrides: Record<string, string> = {}, dir?: string): Config {
  return loadConfig(join(dir ?? tmpdir(), "nonexistent.toml"), {
    QKB_EMBEDDING_PROVIDER: "fake",
    QKB_EMBEDDING_DIM: "8",
    ...overrides,
  });
}

describe("embed/provider getProvider dispatch", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-provider-"));
  });

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("dispatches fake", async () => {
    const cfg = baseConfig();
    const provider = await getProvider(cfg);
    expect(provider).toBeInstanceOf(FakeProvider);
    expect(provider.dimension).toBe(8);
  });

  it("throws naming the unknown provider", async () => {
    const cfg = baseConfig({ QKB_EMBEDDING_PROVIDER: "mystery" });
    await expect(getProvider(cfg)).rejects.toThrow(/mystery/);
  });

  it("dispatches llama, computing modelName from the configured GGUF file without downloading", async () => {
    const cfg = baseConfig(
      {
        QKB_EMBEDDING_PROVIDER: "llama",
        QKB_EMBEDDING_DIM: "768",
        QKB_MODEL_CACHE_DIR: tmpPath,
      },
      tmpPath,
    );
    const provider = await getProvider(cfg);
    expect(provider).toBeInstanceOf(LlamaProvider);
    expect(provider.modelName).toBe("embeddinggemma-300M-Q8_0");
    expect(provider.dimension).toBe(768);
  });

  it("dispatches ollama, threading explicit templates through", async () => {
    const cfg = baseConfig({
      QKB_EMBEDDING_PROVIDER: "ollama",
      QKB_EMBEDDING_MODEL: "hf.co/some/custom-GGUF",
      QKB_EMBEDDING_DIM: "4",
      QKB_EMBEDDING_DOC_TEMPLATE: "passage: {t}",
      QKB_EMBEDDING_QUERY_TEMPLATE: "query: {t}",
    });
    const provider = await getProvider(cfg);
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect((provider as OllamaProvider).docFormat).toBe("passage: {t}");
    expect((provider as OllamaProvider).queryFormat).toBe("query: {t}");
  });

  it("dispatches ollama, defaulting to the per-model heuristic when templates are unset", async () => {
    const cfg = baseConfig({
      QKB_EMBEDDING_PROVIDER: "ollama",
      QKB_EMBEDDING_MODEL: "nomic-embed-text",
      QKB_EMBEDDING_DIM: "4",
    });
    const provider = (await getProvider(cfg)) as OllamaProvider;
    expect(provider.docFormat).toBe("search_document: {t}");
    expect(provider.queryFormat).toBe("search_query: {t}");
  });

  it("dispatches openai, defaulting the base URL to api.openai.com when unset", async () => {
    const cfg = baseConfig({
      QKB_EMBEDDING_PROVIDER: "openai",
      QKB_EMBEDDING_MODEL: "text-embedding-3-small",
      QKB_EMBEDDING_DIM: "4",
      QKB_OPENAI_API_KEY: "sk-test",
    });
    const provider = await getProvider(cfg);
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.modelName).toBe("text-embedding-3-small");
  });
});
