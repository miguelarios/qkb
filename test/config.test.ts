import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `qkb-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("defaults", () => {
    it("loads defaults when config file is missing", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.vaultName).toBe("Notes");
      expect(cfg.embeddingProvider).toBe("llama");
      expect(cfg.embeddingModel).toBe("embeddinggemma-300M-Q8_0");
      expect(cfg.embeddingDim).toBe(768);
      expect(cfg.ftsWeights).toEqual([5.0, 3.0, 2.0, 1.0, 0.5]);
      expect(cfg.frontmatter.created).toEqual(["created", "date created"]);
      expect(cfg.frontmatter.id).toEqual(["id"]);
    });

    it("loads default model cache dir", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb/models"));
    });

    it("loads default ollama_host", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.ollamaHost).toBe("http://localhost:11434");
    });

    it("embedding templates default to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.embeddingDocTemplate).toBeNull();
      expect(cfg.embeddingQueryTemplate).toBeNull();
    });

    it("openai_api_key defaults to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.openaiApiKey).toBeNull();
    });

    it("openai_base_url defaults to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.openaiBaseUrl).toBeNull();
    });

    it("loads local provider defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.localGgufRepo).toBe("ggml-org/embeddinggemma-300M-GGUF");
      expect(cfg.localGgufFile).toBe("embeddinggemma-300M-Q8_0.gguf");
    });
  });

  describe("TOML overrides and alias normalization", () => {
    it("overrides defaults with TOML values", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[vault]
path = "/somewhere/vault"
name = "MyVault"

[embedding]
model = "nomic-embed-text"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.vaultPath).toBe("/somewhere/vault");
      expect(cfg.vaultName).toBe("MyVault");
      expect(cfg.embeddingModel).toBe("nomic-embed-text");
    });

    it("normalizes string aliases to arrays", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[frontmatter]
context = "category"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.frontmatter.context).toEqual(["category"]);
    });

    it("keeps array aliases as arrays", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[frontmatter]
created = ["birth", "created"]
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.frontmatter.created).toEqual(["birth", "created"]);
    });

    it("preserves unmentioned frontmatter keys with defaults", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[frontmatter]
context = "category"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.frontmatter.id).toEqual(["id"]);
    });
  });

  describe("env wins over TOML", () => {
    it("env variables override TOML values", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(configPath, '[vault]\nname = "FromToml"\n');
      const cfg = loadConfig(configPath, {
        QKB_VAULT_NAME: "FromEnv",
        QKB_EMBEDDING_DIM: "512",
      });
      expect(cfg.vaultName).toBe("FromEnv");
      expect(cfg.embeddingDim).toBe(512);
    });
  });

  describe("embedding templates", () => {
    it("loads embedding templates from TOML", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[embedding]
doc_template = "passage: {t}"
query_template = "query: {t}"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.embeddingDocTemplate).toBe("passage: {t}");
      expect(cfg.embeddingQueryTemplate).toBe("query: {t}");
    });

    it("env variables override embedding templates", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {
        QKB_EMBEDDING_DOC_TEMPLATE: "doc: {t}",
        QKB_EMBEDDING_QUERY_TEMPLATE: "query: {t}",
      });
      expect(cfg.embeddingDocTemplate).toBe("doc: {t}");
      expect(cfg.embeddingQueryTemplate).toBe("query: {t}");
    });
  });

  describe("local provider", () => {
    it("loads local provider defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.localGgufRepo).toBe("ggml-org/embeddinggemma-300M-GGUF");
      expect(cfg.localGgufFile).toBe("embeddinggemma-300M-Q8_0.gguf");
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb/models"));
    });

    it("overrides local provider via TOML", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[embedding]
provider = "local"
local_gguf_repo = "example-org/other-model-GGUF"
local_gguf_file = "other-model-Q4_K_M.gguf"
model_cache_dir = "/tmp/qkb-models"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.embeddingProvider).toBe("local");
      expect(cfg.localGgufRepo).toBe("example-org/other-model-GGUF");
      expect(cfg.localGgufFile).toBe("other-model-Q4_K_M.gguf");
      expect(cfg.modelCacheDir).toBe("/tmp/qkb-models");
    });

    it("overrides local provider via env variables", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {
        QKB_LOCAL_GGUF_REPO: "example-org/env-model-GGUF",
        QKB_LOCAL_GGUF_FILE: "env-model.gguf",
        QKB_MODEL_CACHE_DIR: "~/custom-cache",
      });
      expect(cfg.localGgufRepo).toBe("example-org/env-model-GGUF");
      expect(cfg.localGgufFile).toBe("env-model.gguf");
      expect(cfg.modelCacheDir).toBe(join(homedir(), "custom-cache"));
    });
  });

  describe("openai configuration", () => {
    it("loads openai_base_url from TOML", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[embedding]
openai_base_url = "https://api.openai.com/v1"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.openaiBaseUrl).toBe("https://api.openai.com/v1");
    });

    it("overrides openai_base_url via env variable", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[embedding]
openai_base_url = "https://api.openai.com/v1"
`,
      );
      const cfg = loadConfig(configPath, {
        QKB_OPENAI_BASE_URL: "https://custom.openai.com/v1",
      });
      expect(cfg.openaiBaseUrl).toBe("https://custom.openai.com/v1");
    });

    it("loads openai_api_key from env only (never from TOML)", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(configPath, '[embedding]\nopenai_base_url = "test"\n');
      const cfg = loadConfig(configPath, {
        QKB_OPENAI_API_KEY: "sk-test-key",
      });
      expect(cfg.openaiApiKey).toBe("sk-test-key");
    });

    it("does not read openai_api_key from TOML", () => {
      const configPath = join(testDir, "config.toml");
      // Even if TOML has it, it should not be read
      writeFileSync(
        configPath,
        `
[embedding]
openai_api_key = "should-not-read-this"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.openaiApiKey).toBeNull();
    });
  });

  describe("path expansion with ~", () => {
    it("expands ~ in vault_path", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(configPath, '[vault]\npath = "~/my-vault"\n');
      const cfg = loadConfig(configPath, {});
      expect(cfg.vaultPath).toBe(join(homedir(), "my-vault"));
    });

    it("expands ~ in db_path", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(configPath, '[database]\npath = "~/.local/share/qkb/qkb.db"\n');
      const cfg = loadConfig(configPath, {});
      expect(cfg.dbPath).toBe(join(homedir(), ".local/share/qkb/qkb.db"));
    });

    it("expands ~ in model_cache_dir", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(configPath, '[embedding]\nmodel_cache_dir = "~/.cache/qkb"\n');
      const cfg = loadConfig(configPath, {});
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb"));
    });

    it("expands ~ in env variable paths", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {
        QKB_VAULT_PATH: "~/Notes",
        QKB_MODEL_CACHE_DIR: "~/.custom-cache",
      });
      expect(cfg.vaultPath).toBe(join(homedir(), "Notes"));
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".custom-cache"));
    });
  });

  describe("provider defaults", () => {
    it("uses llama as default embedding provider", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.embeddingProvider).toBe("llama");
    });

    it("uses embeddinggemma-300M-Q8_0 as default embedding model", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.embeddingModel).toBe("embeddinggemma-300M-Q8_0");
    });
  });

  describe("search tuning defaults", () => {
    it("loads search tuning defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.defaultLimit).toBe(10);
      expect(cfg.rrfK).toBe(60);
      expect(cfg.vecCandidates).toBe(30);
      expect(cfg.ftsCandidates).toBe(30);
      expect(cfg.ftsWeights).toEqual([5.0, 3.0, 2.0, 1.0, 0.5]);
    });

    it("overrides search tuning via TOML", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[search]
default_limit = 20
rrf_k = 100
vec_candidates = 50
fts_candidates = 50
fts_weights = [3.0, 2.0, 1.0]
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.defaultLimit).toBe(20);
      expect(cfg.rrfK).toBe(100);
      expect(cfg.vecCandidates).toBe(50);
      expect(cfg.ftsCandidates).toBe(50);
      expect(cfg.ftsWeights).toEqual([3.0, 2.0, 1.0]);
    });
  });

  describe("chunking defaults", () => {
    it("loads chunking defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.toml"), {});
      expect(cfg.chunkTargetTokens).toBe(500);
      expect(cfg.chunkOverlapPercent).toBe(15);
    });

    it("overrides chunking via TOML", () => {
      const configPath = join(testDir, "config.toml");
      writeFileSync(
        configPath,
        `
[chunking]
target_tokens = 1000
overlap_percent = 20
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.chunkTargetTokens).toBe(1000);
      expect(cfg.chunkOverlapPercent).toBe(20);
    });
  });

  describe("QKB_CONFIG env variable", () => {
    it("uses QKB_CONFIG to specify config path", () => {
      const configPath = join(testDir, "custom.toml");
      writeFileSync(configPath, '[vault]\nname = "CustomFromEnv"\n');
      const cfg = loadConfig(join(testDir, "should-not-exist.toml"), {
        QKB_CONFIG: configPath,
      });
      expect(cfg.vaultName).toBe("CustomFromEnv");
    });
  });
});
