import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface Config {
  vaultPath: string;
  vaultName: string;
  dbPath: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDim: number;
  ollamaHost: string;
  embeddingDocTemplate: string | null;
  embeddingQueryTemplate: string | null;
  localGgufRepo: string;
  localGgufFile: string;
  modelCacheDir: string;
  chunkTargetTokens: number;
  chunkOverlapPercent: number;
  defaultLimit: number;
  rrfK: number;
  vecCandidates: number;
  ftsCandidates: number;
  ftsWeights: number[];
  frontmatter: Record<string, string[]>;
  openaiBaseUrl: string | null;
  openaiApiKey: string | null;
}

export const DEFAULT_FRONTMATTER: Record<string, string[]> = {
  id: ["id"],
  type: ["type"],
  title: ["title"],
  context: ["context"],
  source: ["source"],
  date: ["date"],
  created: ["created", "date created"],
  tags: ["tags"],
};

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "qkb", "config.toml");

// (toml_section, toml_key, Config property, caster)
type TomlEntry = [string, string, keyof Config, (val: unknown) => unknown];

const TOML_MAP: TomlEntry[] = [
  ["vault", "path", "vaultPath", (v) => String(v)],
  ["vault", "name", "vaultName", (v) => String(v)],
  ["database", "path", "dbPath", (v) => String(v)],
  ["embedding", "provider", "embeddingProvider", (v) => String(v)],
  ["embedding", "model", "embeddingModel", (v) => String(v)],
  ["embedding", "dimension", "embeddingDim", (v) => Number(v)],
  ["embedding", "ollama_host", "ollamaHost", (v) => String(v)],
  ["embedding", "doc_template", "embeddingDocTemplate", (v) => (v ? String(v) : null)],
  ["embedding", "query_template", "embeddingQueryTemplate", (v) => (v ? String(v) : null)],
  ["embedding", "local_gguf_repo", "localGgufRepo", (v) => String(v)],
  ["embedding", "local_gguf_file", "localGgufFile", (v) => String(v)],
  ["embedding", "model_cache_dir", "modelCacheDir", (v) => String(v)],
  ["embedding", "openai_base_url", "openaiBaseUrl", (v) => (v ? String(v) : null)],
  ["chunking", "target_tokens", "chunkTargetTokens", (v) => Number(v)],
  ["chunking", "overlap_percent", "chunkOverlapPercent", (v) => Number(v)],
  ["search", "default_limit", "defaultLimit", (v) => Number(v)],
  ["search", "rrf_k", "rrfK", (v) => Number(v)],
  ["search", "vec_candidates", "vecCandidates", (v) => Number(v)],
  ["search", "fts_candidates", "ftsCandidates", (v) => Number(v)],
  ["search", "fts_weights", "ftsWeights", (v) => (Array.isArray(v) ? v.map((x) => Number(x)) : [])],
];

// QKB_<NAME> env var -> Config property
type EnvEntry = [string, keyof Config, (val: string) => unknown];

const ENV_MAP: EnvEntry[] = [
  ["QKB_VAULT_PATH", "vaultPath", (v) => String(v)],
  ["QKB_VAULT_NAME", "vaultName", (v) => String(v)],
  ["QKB_DB_PATH", "dbPath", (v) => String(v)],
  ["QKB_EMBEDDING_PROVIDER", "embeddingProvider", (v) => String(v)],
  ["QKB_EMBEDDING_MODEL", "embeddingModel", (v) => String(v)],
  ["QKB_EMBEDDING_DIM", "embeddingDim", (v) => Number(v)],
  ["QKB_OLLAMA_HOST", "ollamaHost", (v) => String(v)],
  ["QKB_EMBEDDING_DOC_TEMPLATE", "embeddingDocTemplate", (v) => (v ? String(v) : null)],
  ["QKB_EMBEDDING_QUERY_TEMPLATE", "embeddingQueryTemplate", (v) => (v ? String(v) : null)],
  ["QKB_LOCAL_GGUF_REPO", "localGgufRepo", (v) => String(v)],
  ["QKB_LOCAL_GGUF_FILE", "localGgufFile", (v) => String(v)],
  ["QKB_MODEL_CACHE_DIR", "modelCacheDir", (v) => String(v)],
  ["QKB_OPENAI_BASE_URL", "openaiBaseUrl", (v) => (v ? String(v) : null)],
  ["QKB_OPENAI_API_KEY", "openaiApiKey", (v) => (v ? String(v) : null)],
];

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  env: Record<string, string> = process.env as Record<string, string>,
): Config {
  // Start with defaults
  const cfg: Config = {
    vaultPath: join(homedir(), "Notes"),
    vaultName: "Notes",
    dbPath: join(homedir(), ".local/share/qkb/qkb.db"),
    embeddingProvider: "llama",
    embeddingModel: "embeddinggemma-300M-Q8_0",
    embeddingDim: 768,
    ollamaHost: "http://localhost:11434",
    embeddingDocTemplate: null,
    embeddingQueryTemplate: null,
    localGgufRepo: "ggml-org/embeddinggemma-300M-GGUF",
    localGgufFile: "embeddinggemma-300M-Q8_0.gguf",
    modelCacheDir: join(homedir(), ".cache/qkb/models"),
    chunkTargetTokens: 500,
    chunkOverlapPercent: 15,
    defaultLimit: 10,
    rrfK: 60,
    vecCandidates: 30,
    ftsCandidates: 30,
    ftsWeights: [5.0, 3.0, 2.0, 1.0, 0.5],
    frontmatter: { ...DEFAULT_FRONTMATTER },
    openaiBaseUrl: null,
    openaiApiKey: null,
  };

  // Check if we should use a different config path from env
  const actualConfigPath = env.QKB_CONFIG || configPath;

  // Load from TOML file if it exists
  try {
    const content = readFileSync(actualConfigPath, "utf-8");
    const data = parse(content) as Record<string, unknown>;

    for (const [section, key, attr, caster] of TOML_MAP) {
      // Skip openai_api_key from TOML (env only)
      if (key === "openai_api_key") continue;

      const sectionData = data[section] as Record<string, unknown> | undefined;
      if (sectionData && key in sectionData) {
        const value = caster(sectionData[key]);
        cfg[attr] = value as never;
      }
    }

    // Handle frontmatter aliases
    const frontmatterData = data.frontmatter as Record<string, unknown> | undefined;
    if (frontmatterData) {
      for (const [canonical, aliases] of Object.entries(frontmatterData)) {
        if (canonical in cfg.frontmatter) {
          if (typeof aliases === "string") {
            cfg.frontmatter[canonical] = [aliases];
          } else if (Array.isArray(aliases)) {
            cfg.frontmatter[canonical] = aliases.map((a) => String(a));
          }
        }
      }
    }
  } catch {
    // File doesn't exist or can't be read, use defaults
  }

  // Apply env variable overrides
  for (const [envVar, attr, caster] of ENV_MAP) {
    if (envVar in env) {
      const value = caster(env[envVar] as string);
      cfg[attr] = value as never;
    }
  }

  // Expand ~ in paths
  cfg.vaultPath = expandPath(cfg.vaultPath);
  cfg.dbPath = expandPath(cfg.dbPath);
  cfg.modelCacheDir = expandPath(cfg.modelCacheDir);

  return cfg;
}
