import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadConfig, resolveConfigPath } from "../src/config.js";

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
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.vaultName).toBe("Notes");
      expect(cfg.embeddingProvider).toBe("llama");
      expect(cfg.embeddingModel).toBe("embeddinggemma-300M-Q8_0");
      expect(cfg.embeddingDim).toBe(768);
      expect(cfg.ftsWeights).toEqual({
        title: 5.0,
        aliases: 5.0,
        headings: 3.0,
        tags: 3.0,
        sibling_fields: 3.0,
        fields: 2.0,
        body: 1.0,
        type: 0.5,
      });
      expect(cfg.frontmatter.created).toEqual(["created", "date created"]);
      expect(cfg.frontmatter.id).toEqual(["id"]);
    });

    it("loads default model cache dir", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb/models"));
    });

    it("loads default ollama_host", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.ollamaHost).toBe("http://localhost:11434");
    });

    it("embedding templates default to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.embeddingDocTemplate).toBeNull();
      expect(cfg.embeddingQueryTemplate).toBeNull();
    });

    it("openai_api_key defaults to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.openaiApiKey).toBeNull();
    });

    it("openai_base_url defaults to null", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.openaiBaseUrl).toBeNull();
    });

    it("loads local provider defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.localGgufRepo).toBe("ggml-org/embeddinggemma-300M-GGUF");
      expect(cfg.localGgufFile).toBe("embeddinggemma-300M-Q8_0.gguf");
    });
  });

  /** Write `content` to `name` in the test dir and return its path. */
  function file(name: string, content: string): string {
    const p = join(testDir, name);
    writeFileSync(p, content);
    return p;
  }

  describe("YAML overrides and alias normalization", () => {
    it("overrides defaults with YAML values", () => {
      const configPath = file(
        "config.yaml",
        `
vault:
  path: /somewhere/vault
  name: MyVault

embedding:
  model: nomic-embed-text
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.vaultPath).toBe("/somewhere/vault");
      expect(cfg.vaultName).toBe("MyVault");
      expect(cfg.embeddingModel).toBe("nomic-embed-text");
    });

    it("normalizes string aliases to arrays", () => {
      const cfg = loadConfig(file("config.yaml", "frontmatter:\n  id: uuid\n"), {});
      expect(cfg.frontmatter.id).toEqual(["uuid"]);
    });

    it("keeps array aliases as arrays (flow and block lists)", () => {
      const flow = loadConfig(file("a.yaml", "frontmatter:\n  created: [birth, created]\n"), {});
      expect(flow.frontmatter.created).toEqual(["birth", "created"]);
      const block = loadConfig(
        file("b.yaml", "frontmatter:\n  created:\n    - birth\n    - created\n"),
        {},
      );
      expect(block.frontmatter.created).toEqual(["birth", "created"]);
    });

    it("preserves unmentioned frontmatter keys with defaults", () => {
      const cfg = loadConfig(file("config.yaml", "frontmatter:\n  title: name\n"), {});
      expect(cfg.frontmatter.id).toEqual(["id"]);
    });
  });

  describe("YAML specifics", () => {
    it("an empty file or a comment-only file means defaults", () => {
      expect(loadConfig(file("empty.yaml", ""), {}).vaultName).toBe("Notes");
      expect(loadConfig(file("comments.yaml", "# nothing yet\n"), {}).vaultName).toBe("Notes");
    });

    it("an empty value or empty section is unset, not the string 'null'", () => {
      const cfg = loadConfig(file("config.yaml", "vault:\n  name:\nsearch:\n"), {});
      expect(cfg.vaultName).toBe("Notes");
      expect(cfg.defaultLimit).toBe(10);
    });

    it("keeps date-like and yes/no scalars as strings (YAML 1.2 core schema)", () => {
      const cfg = loadConfig(
        file("config.yaml", "vault:\n  name: 2026-01-01\nembedding:\n  model: no\n"),
        {},
      );
      expect(cfg.vaultName).toBe("2026-01-01");
      expect(cfg.embeddingModel).toBe("no");
    });

    it("a .yml extension works too", () => {
      expect(loadConfig(file("config.yml", "vault:\n  name: Yml\n"), {}).vaultName).toBe("Yml");
    });

    it("rejects a file that is not a mapping", () => {
      expect(() => loadConfig(file("list.yaml", "- a\n- b\n"), {})).toThrow(
        /must be a YAML mapping/,
      );
    });

    it("reports a syntax error with the file name instead of falling back to defaults", () => {
      const p = file("bad.yaml", "vault:\n  name: [unclosed\n");
      expect(() => loadConfig(p, {})).toThrow(/bad\.yaml/);
    });
  });

  describe("env wins over the config file", () => {
    it("env variables override config values", () => {
      const configPath = file("config.yaml", "vault:\n  name: FromFile\n");
      const cfg = loadConfig(configPath, {
        QKB_VAULT_NAME: "FromEnv",
        QKB_EMBEDDING_DIM: "512",
      });
      expect(cfg.vaultName).toBe("FromEnv");
      expect(cfg.embeddingDim).toBe(512);
    });
  });

  describe("embedding templates", () => {
    it("loads embedding templates from the config file", () => {
      const configPath = file(
        "config.yaml",
        `
embedding:
  doc_template: "passage: {t}"
  query_template: "query: {t}"
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.embeddingDocTemplate).toBe("passage: {t}");
      expect(cfg.embeddingQueryTemplate).toBe("query: {t}");
    });

    it("env variables override embedding templates", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {
        QKB_EMBEDDING_DOC_TEMPLATE: "doc: {t}",
        QKB_EMBEDDING_QUERY_TEMPLATE: "query: {t}",
      });
      expect(cfg.embeddingDocTemplate).toBe("doc: {t}");
      expect(cfg.embeddingQueryTemplate).toBe("query: {t}");
    });
  });

  describe("local provider", () => {
    it("loads local provider defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.localGgufRepo).toBe("ggml-org/embeddinggemma-300M-GGUF");
      expect(cfg.localGgufFile).toBe("embeddinggemma-300M-Q8_0.gguf");
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb/models"));
    });

    it("overrides local provider via the config file", () => {
      const configPath = file(
        "config.yaml",
        `
embedding:
  provider: local
  local_gguf_repo: example-org/other-model-GGUF
  local_gguf_file: other-model-Q4_K_M.gguf
  model_cache_dir: /tmp/qkb-models
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.embeddingProvider).toBe("local");
      expect(cfg.localGgufRepo).toBe("example-org/other-model-GGUF");
      expect(cfg.localGgufFile).toBe("other-model-Q4_K_M.gguf");
      expect(cfg.modelCacheDir).toBe("/tmp/qkb-models");
    });

    it("overrides local provider via env variables", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {
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
    it("loads openai_base_url from the config file", () => {
      const configPath = file(
        "config.yaml",
        "embedding:\n  openai_base_url: https://api.openai.com/v1\n",
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.openaiBaseUrl).toBe("https://api.openai.com/v1");
    });

    it("overrides openai_base_url via env variable", () => {
      const configPath = file(
        "config.yaml",
        "embedding:\n  openai_base_url: https://api.openai.com/v1\n",
      );
      const cfg = loadConfig(configPath, {
        QKB_OPENAI_BASE_URL: "https://custom.openai.com/v1",
      });
      expect(cfg.openaiBaseUrl).toBe("https://custom.openai.com/v1");
    });

    it("loads openai_api_key from env only", () => {
      const configPath = file("config.yaml", "embedding:\n  openai_base_url: test\n");
      const cfg = loadConfig(configPath, {
        QKB_OPENAI_API_KEY: "sk-test-key",
      });
      expect(cfg.openaiApiKey).toBe("sk-test-key");
    });

    it("does not read openai_api_key from the config file", () => {
      const configPath = file(
        "config.yaml",
        "embedding:\n  openai_api_key: should-not-read-this\n",
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.openaiApiKey).toBeNull();
    });
  });

  describe("path expansion with ~", () => {
    it("expands ~ in vault_path", () => {
      const cfg = loadConfig(file("config.yaml", "vault:\n  path: ~/my-vault\n"), {});
      expect(cfg.vaultPath).toBe(join(homedir(), "my-vault"));
    });

    it("expands ~ in db_path", () => {
      const cfg = loadConfig(
        file("config.yaml", "database:\n  path: ~/.local/share/qkb/qkb.db\n"),
        {},
      );
      expect(cfg.dbPath).toBe(join(homedir(), ".local/share/qkb/qkb.db"));
    });

    it("expands ~ in model_cache_dir", () => {
      const cfg = loadConfig(
        file("config.yaml", "embedding:\n  model_cache_dir: ~/.cache/qkb\n"),
        {},
      );
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".cache/qkb"));
    });

    it("expands ~ in env variable paths", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {
        QKB_VAULT_PATH: "~/Notes",
        QKB_MODEL_CACHE_DIR: "~/.custom-cache",
      });
      expect(cfg.vaultPath).toBe(join(homedir(), "Notes"));
      expect(cfg.modelCacheDir).toBe(join(homedir(), ".custom-cache"));
    });
  });

  describe("provider defaults", () => {
    it("uses llama as default embedding provider", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.embeddingProvider).toBe("llama");
    });

    it("uses embeddinggemma-300M-Q8_0 as default embedding model", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.embeddingModel).toBe("embeddinggemma-300M-Q8_0");
    });
  });

  describe("search tuning defaults", () => {
    it("loads search tuning defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.defaultLimit).toBe(10);
      expect(cfg.rrfK).toBe(60);
      expect(cfg.vecCandidates).toBe(30);
      expect(cfg.ftsCandidates).toBe(30);
      expect(cfg.ftsWeights.title).toBe(5.0);
      expect(cfg.ftsWeights.body).toBe(1.0);
    });

    it("overrides search tuning via the config file", () => {
      const configPath = file(
        "config.yaml",
        `
search:
  default_limit: 20
  rrf_k: 100
  vec_candidates: 50
  fts_candidates: 50
  fts_weights:
    title: 8.0
    body: 0.5
`,
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.defaultLimit).toBe(20);
      expect(cfg.rrfK).toBe(100);
      expect(cfg.vecCandidates).toBe(50);
      expect(cfg.ftsCandidates).toBe(50);
      expect(cfg.ftsWeights.title).toBe(8.0);
      expect(cfg.ftsWeights.body).toBe(0.5);
      expect(cfg.ftsWeights.tags).toBe(3.0); // unmentioned columns keep their default
    });

    it("rejects the old positional fts_weights array and unknown columns with a clear message", () => {
      const configPath = file("config.yaml", "search:\n  fts_weights: [5.0, 3.0, 2.0, 1.0, 0.5]\n");
      expect(() => loadConfig(configPath, {})).toThrow(/fts_weights is now a table/);
      writeFileSync(configPath, "search:\n  fts_weights:\n    context: 2.0\n");
      expect(() => loadConfig(configPath, {})).toThrow(/unknown fts_weights column "context"/);
    });
  });

  describe("chunking defaults", () => {
    it("loads chunking defaults", () => {
      const cfg = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(cfg.chunkTargetTokens).toBe(500);
      expect(cfg.chunkOverlapPercent).toBe(15);
    });

    it("overrides chunking via the config file", () => {
      const configPath = file(
        "config.yaml",
        "chunking:\n  target_tokens: 1000\n  overlap_percent: 20\n",
      );
      const cfg = loadConfig(configPath, {});
      expect(cfg.chunkTargetTokens).toBe(1000);
      expect(cfg.chunkOverlapPercent).toBe(20);
    });
  });

  describe("QKB_CONFIG env variable", () => {
    it("uses QKB_CONFIG to specify config path", () => {
      const configPath = file("custom.yaml", "vault:\n  name: CustomFromEnv\n");
      const cfg = loadConfig(join(testDir, "should-not-exist.yaml"), {
        QKB_CONFIG: configPath,
      });
      expect(cfg.vaultName).toBe("CustomFromEnv");
    });
  });

  describe("rerank and expansion (#37, #38)", () => {
    it("are off by default and read from config and env", () => {
      const off = loadConfig(join(testDir, "nonexistent.yaml"), {});
      expect(off.rerankEnabled).toBe(false);
      expect(off.expansionEnabled).toBe(false);
      expect(off.rerankCandidates).toBe(30);

      const configPath = file(
        "llm.yaml",
        "rerank:\n  enabled: true\n  candidates: 50\nexpansion:\n  max_variants: 2\n",
      );
      const on = loadConfig(configPath, { QKB_EXPANSION: "yes", QKB_RERANK_PROVIDER: "fake" });
      expect(on.rerankEnabled).toBe(true);
      expect(on.rerankCandidates).toBe(50);
      expect(on.rerankProvider).toBe("fake");
      expect(on.expansionEnabled).toBe(true);
      expect(on.expansionMaxVariants).toBe(2);
    });
  });

  describe("legacy TOML config (deprecated)", () => {
    const TOML = `
[vault]
name = "Personal"

[embedding]
dimension = 512

[search.fts_weights]
title = 8.0

[frontmatter]
id = "uuid"
created = ["birth", "created"]

[frontmatter.fields]
project = "Project"
source = { description = "Where it came from", siblings = true }

[[vaults]]
name = "Personal"
path = "/data/personal"

[[vaults]]
path = "/data/wiki"
include_by_default = false
`;
    const YAML = `
vault:
  name: Personal
embedding:
  dimension: 512
search:
  fts_weights:
    title: 8.0
frontmatter:
  id: uuid
  created: [birth, created]
  fields:
    project: Project
    source: { description: Where it came from, siblings: true }
vaults:
  - name: Personal
    path: /data/personal
  - path: /data/wiki
    include_by_default: false
`;

    let errSpy: MockInstance<typeof console.error>;
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      errSpy.mockRestore();
    });

    it("a .toml file still loads, to the same config as its YAML equivalent", () => {
      const fromToml = loadConfig(file("config.toml", TOML), {});
      const fromYaml = loadConfig(file("other.yaml", YAML), {});
      expect(fromToml).toEqual(fromYaml);
      expect(fromToml.siblingFields).toEqual(["source"]);
      expect(fromToml.vaults.map((v) => v.includeByDefault)).toEqual([true, false]);
    });

    it("warns on stderr, once per file, that TOML is deprecated", () => {
      const p = file("warn-once.toml", '[vault]\nname = "X"\n');
      loadConfig(p, {});
      loadConfig(p, {});
      const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("warn-once.toml"));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toMatch(/deprecated/);
    });

    it("falls back to a config.toml next to a missing config.yaml", () => {
      file("config.toml", '[vault]\nname = "FromLegacy"\n');
      const yamlPath = join(testDir, "config.yaml");
      expect(resolveConfigPath(yamlPath, {})).toBe(join(testDir, "config.toml"));
      expect(loadConfig(yamlPath, {}).vaultName).toBe("FromLegacy");
    });

    it("prefers config.yaml when both exist", () => {
      file("config.toml", '[vault]\nname = "FromLegacy"\n');
      const yamlPath = file("config.yaml", "vault:\n  name: FromYaml\n");
      expect(loadConfig(yamlPath, {}).vaultName).toBe("FromYaml");
    });

    it("applies the same fallback to a QKB_CONFIG path (e.g. a container's mount)", () => {
      file("config.toml", '[vault]\nname = "FromLegacy"\n');
      const env = { QKB_CONFIG: join(testDir, "config.yaml") };
      expect(loadConfig(join(testDir, "other.yaml"), env).vaultName).toBe("FromLegacy");
    });

    it("a missing file with no legacy twin still means defaults", () => {
      expect(resolveConfigPath(join(testDir, "config.yaml"), {})).toBe(
        join(testDir, "config.yaml"),
      );
      expect(loadConfig(join(testDir, "config.yaml"), {}).vaultName).toBe("Notes");
    });
  });
});
