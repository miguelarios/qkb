import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
// Default import: js-yaml v3 is CJS — see the note in src/ingest/parser.ts.
import yaml from "js-yaml";
import { parse as parseToml } from "smol-toml";

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
  /** BM25 weight per FTS column (see FTS_COLUMNS in src/db/schema.ts). */
  ftsWeights: Record<string, number>;
  frontmatter: Record<string, string[]>;
  openaiBaseUrl: string | null;
  openaiApiKey: string | null;
  /** Extra vaults from the `vaults:` list. Empty means "the single vault in
   * `vaultPath`/`vaultName`" — read vaults through `configuredVaults()`, never
   * this field directly. */
  vaults: Vault[];
  /** Declared extra frontmatter properties (`frontmatter.fields`): key ->
   * short description for agents. Declared keys are searchable, embedded, and
   * returned in results; undeclared extra keys are only stored. */
  fields: Record<string, string>;
  /** Declared fields with `siblings: true`: notes sharing a value are
   * related to each other, and the values rank like tags. */
  siblingFields: string[];
  mcpHost: string;
  mcpPort: number;
  /** Browser origins accepted by the HTTP MCP server besides loopback. `*`
   * disables the check. */
  mcpAllowedOrigins: string[];
  /** Seconds between automatic re-index runs in watch mode. */
  watchInterval: number;
  /** Rerank hybrid results with a cross-encoder (#37). Off by default. */
  rerankEnabled: boolean;
  rerankProvider: string;
  rerankGgufRepo: string;
  rerankGgufFile: string;
  /** How many top hybrid candidates the reranker re-scores. */
  rerankCandidates: number;
  /** Expand a query into variants with a small local model (#38). Off by default. */
  expansionEnabled: boolean;
  expansionProvider: string;
  expansionGgufRepo: string;
  expansionGgufFile: string;
  expansionMaxVariants: number;
}

export interface Vault {
  name: string;
  path: string;
  /** Searched when a search names no vault. `include_by_default: false`
   * keeps a vault indexed but out of unscoped searches (#54). */
  includeByDefault: boolean;
}

/** Every vault qkb indexes: the `vaults:` list, or the single
 * `vault:` / `vaultPath` entry when no list is configured. */
export function configuredVaults(cfg: Config): Vault[] {
  if (cfg.vaults.length > 0) return cfg.vaults;
  return [{ name: cfg.vaultName, path: cfg.vaultPath, includeByDefault: true }];
}

/** Look up a configured vault by name (for reading a document's file back). */
export function vaultPathFor(cfg: Config, vaultName: string): string | undefined {
  return configuredVaults(cfg).find((v) => v.name === vaultName)?.path;
}

/** Built-in properties qkb understands without configuration, each with its
 * accepted aliases. Only `id` is required (#33); everything else is
 * optional. Any other property can be declared in `frontmatter.fields`. */
export const DEFAULT_FRONTMATTER: Record<string, string[]> = {
  id: ["id"],
  type: ["type"],
  title: ["title"],
  aliases: ["aliases", "alias"],
  date: ["date"],
  created: ["created", "date created"],
  modified: ["modified", "updated", "date modified"],
  tags: ["tags", "tag"],
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "qkb", "config.yaml");

/** The config file `loadConfig` reads: `QKB_CONFIG` if set, else
 * `configPath`. When that is a `.yaml`/`.yml` path that doesn't exist, the
 * same name with the other YAML extension is tried, then a legacy `.toml`
 * file beside it (ADR-023) — so `config.yml`, an existing
 * `~/.config/qkb/config.toml`, or a container's mounted `/config/config.toml`
 * all keep working. */
export function resolveConfigPath(
  configPath: string = DEFAULT_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): string {
  const path = env.QKB_CONFIG || configPath;
  const m = /\.(ya?ml)$/i.exec(path);
  if (m && !existsSync(path)) {
    const stem = path.slice(0, -m[0].length);
    const otherYaml = `${stem}.${m[1]?.toLowerCase() === "yml" ? "yaml" : "yml"}`;
    for (const candidate of [otherYaml, `${stem}.toml`]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return path;
}

const warnedTomlPaths = new Set<string>();

/** Parse a config file: YAML, or TOML for a legacy `.toml` file. Both yield
 * the same nested shape, so one loader handles either. */
function parseConfigFile(path: string, content: string): Record<string, unknown> {
  if (extname(path).toLowerCase() === ".toml") {
    if (!warnedTomlPaths.has(path)) {
      warnedTomlPaths.add(path);
      // stderr: stdout carries --json output and the MCP stdio protocol.
      console.error(
        `qkb: ${path} is TOML, which is deprecated — move it to YAML ` +
          `(${path.replace(/\.toml$/i, ".yaml")}; same sections and keys). TOML support will be removed in a future release.`,
      );
    }
    return parseToml(content) as Record<string, unknown>;
  }
  // CORE_SCHEMA: no timestamp objects, and `yes`/`no`/`on`/`off` stay
  // strings. It still reads YAML 1.1 numbers (`0755` is octal, `1:30` is
  // base 60), so string settings are type-checked in `str` below.
  let data: unknown;
  try {
    data = yaml.load(content, { schema: yaml.CORE_SCHEMA, filename: path });
  } catch (e) {
    // A TOML file under a non-.toml name (e.g. via QKB_CONFIG) would only
    // report a YAML syntax error; say what it most likely is.
    if (/^\s*\[[^\]\n]+\]\s*$/m.test(content) || /^\s*[\w"-]+\s*=/m.test(content)) {
      throw new Error(
        `${(e as Error).message}\nconfig: ${path} looks like TOML — rename it to .toml or convert it to YAML`,
      );
    }
    throw e;
  }
  if (data === null || data === undefined) return {}; // empty file
  if (!isMapping(data)) {
    throw new Error(
      `config: ${path} must be a YAML mapping (e.g. \`vault:\` with \`path:\` under it)`,
    );
  }
  rejectMergeKeys(data, path);
  // Unknown top-level keys are almost always an indentation mistake
  // (`vault:` followed by an unindented `path:`), which would otherwise load
  // defaults silently. Legacy TOML files keep the old lenient behaviour.
  for (const key of Object.keys(data)) {
    if (!SECTIONS.has(key)) {
      throw new Error(
        `config: unknown top-level key "${key}" in ${path} — check its indentation ` +
          `(sections: ${[...SECTIONS].join(", ")})`,
      );
    }
  }
  return data;
}

/** The core schema has no merge type, so `<<: *anchor` would be kept as a
 * literal key and its settings silently ignored. */
function rejectMergeKeys(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    for (const x of v) rejectMergeKeys(x, path);
  } else if (isMapping(v)) {
    if ("<<" in v) {
      throw new Error(`config: ${path} uses a YAML merge key (<<), which qkb does not support`);
    }
    for (const x of Object.values(v)) rejectMergeKeys(x, path);
  }
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A string setting. YAML turns unquoted `0755`, `2024.10` or `1:30` into
 * numbers, and `String()` would then store `"493"`, `"2024.1"` or `"90"`;
 * refuse instead, so the fix (quote it) is obvious. */
function str(v: unknown, where: string): string {
  if (typeof v !== "string") {
    throw new Error(
      v === null
        ? `config: ${where} is empty — give it a value or remove it`
        : `config: ${where} must be a string; got ${JSON.stringify(v)} — put it in quotes`,
    );
  }
  return v;
}

/** An optional string setting: empty means unset. */
function optStr(v: unknown, where: string): string | null {
  return v === "" ? null : str(v, where);
}

function num(v: unknown, where: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`config: ${where} must be a number; got ${JSON.stringify(v)}`);
  }
  return n;
}

// (section, key, Config property, caster)
type FileEntry = [string, string, keyof Config, (val: unknown, where: string) => unknown];

const FILE_MAP: FileEntry[] = [
  ["vault", "path", "vaultPath", str],
  ["vault", "name", "vaultName", str],
  ["database", "path", "dbPath", str],
  ["embedding", "provider", "embeddingProvider", str],
  ["embedding", "model", "embeddingModel", str],
  ["embedding", "dimension", "embeddingDim", num],
  ["embedding", "ollama_host", "ollamaHost", str],
  ["embedding", "doc_template", "embeddingDocTemplate", optStr],
  ["embedding", "query_template", "embeddingQueryTemplate", optStr],
  ["embedding", "local_gguf_repo", "localGgufRepo", str],
  ["embedding", "local_gguf_file", "localGgufFile", str],
  ["embedding", "model_cache_dir", "modelCacheDir", str],
  ["embedding", "openai_base_url", "openaiBaseUrl", optStr],
  ["chunking", "target_tokens", "chunkTargetTokens", num],
  ["chunking", "overlap_percent", "chunkOverlapPercent", num],
  ["search", "default_limit", "defaultLimit", num],
  ["search", "rrf_k", "rrfK", num],
  ["search", "vec_candidates", "vecCandidates", num],
  ["search", "fts_candidates", "ftsCandidates", num],
  ["search", "fts_weights", "ftsWeights", (v) => parseFtsWeights(v)],
  ["mcp", "host", "mcpHost", str],
  ["mcp", "port", "mcpPort", num],
  ["mcp", "allowed_origins", "mcpAllowedOrigins", (v, w) => toList(v, w)],
  ["watch", "interval", "watchInterval", num],
  ["rerank", "enabled", "rerankEnabled", (v) => toBool(v)],
  ["rerank", "provider", "rerankProvider", str],
  ["rerank", "gguf_repo", "rerankGgufRepo", str],
  ["rerank", "gguf_file", "rerankGgufFile", str],
  ["rerank", "candidates", "rerankCandidates", num],
  ["expansion", "enabled", "expansionEnabled", (v) => toBool(v)],
  ["expansion", "provider", "expansionProvider", str],
  ["expansion", "gguf_repo", "expansionGgufRepo", str],
  ["expansion", "gguf_file", "expansionGgufFile", str],
  ["expansion", "max_variants", "expansionMaxVariants", num],
];

/** Every top-level key a YAML config may have. */
const SECTIONS = new Set([...FILE_MAP.map((e) => e[0]), "frontmatter", "vaults"]);

/** A `frontmatter.fields` entry: `key: description`, or a mapping
 * `key: { description: ..., siblings: true }`. */
function parseFieldSpec(key: string, spec: unknown): { description: string; siblings: boolean } {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    const t = spec as Record<string, unknown>;
    for (const k of Object.keys(t)) {
      if (k !== "description" && k !== "siblings") {
        throw new Error(
          `config: frontmatter.fields.${key} has unknown key "${k}" (expected description, siblings)`,
        );
      }
    }
    if (t.siblings !== undefined && typeof t.siblings !== "boolean") {
      throw new Error(`config: frontmatter.fields.${key}.siblings must be true or false`);
    }
    return { description: String(t.description ?? ""), siblings: t.siblings === true };
  }
  return { description: String(spec ?? ""), siblings: false };
}

function toBool(v: unknown): boolean {
  return v === true || ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

/** Default BM25 weights: short, deliberate text (title, aliases) counts most;
 * headings and tags next; declared fields, then body text; `type` barely. */
export const DEFAULT_FTS_WEIGHTS: Record<string, number> = {
  title: 5.0,
  aliases: 5.0,
  headings: 3.0,
  tags: 3.0,
  sibling_fields: 3.0,
  fields: 2.0,
  body: 1.0,
  type: 0.5,
};

function parseFtsWeights(v: unknown): Record<string, number> {
  if (Array.isArray(v) || typeof v !== "object" || v === null) {
    throw new Error(
      "config: search.fts_weights is now a table (mapping), e.g.\n" +
        "  search:\n    fts_weights:\n      title: 5.0\n      body: 1.0\n" +
        `(columns: ${Object.keys(DEFAULT_FTS_WEIGHTS).join(", ")})`,
    );
  }
  const out = { ...DEFAULT_FTS_WEIGHTS };
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    if (w === null) continue; // `title:` left empty: keep the default
    if (!(k in DEFAULT_FTS_WEIGHTS)) {
      throw new Error(
        `config: unknown fts_weights column "${k}" (columns: ${Object.keys(DEFAULT_FTS_WEIGHTS).join(", ")})`,
      );
    }
    const n = Number(w);
    if (!Number.isFinite(n) || n < 0) throw new Error(`config: fts_weights.${k} must be >= 0`);
    out[k] = n;
  }
  return out;
}

function toList(v: unknown, where = "list"): string[] {
  // Items must be strings: YAML `- ` (null) would otherwise become the string
  // "null" — for allowed_origins, the Origin that sandboxed pages send.
  if (Array.isArray(v)) return v.map((x, i) => str(x, `${where}[${i}]`).trim()).filter(Boolean);
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

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
  ["QKB_MCP_HOST", "mcpHost", (v) => String(v)],
  ["QKB_MCP_PORT", "mcpPort", (v) => Number(v)],
  ["QKB_ALLOWED_ORIGINS", "mcpAllowedOrigins", (v) => toList(v)],
  ["QKB_WATCH_INTERVAL", "watchInterval", (v) => Number(v)],
  ["QKB_RERANK", "rerankEnabled", (v) => toBool(v)],
  ["QKB_RERANK_PROVIDER", "rerankProvider", (v) => String(v)],
  ["QKB_EXPANSION", "expansionEnabled", (v) => toBool(v)],
  ["QKB_EXPANSION_PROVIDER", "expansionProvider", (v) => String(v)],
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
    ftsWeights: { ...DEFAULT_FTS_WEIGHTS },
    frontmatter: { ...DEFAULT_FRONTMATTER },
    openaiBaseUrl: null,
    openaiApiKey: null,
    vaults: [],
    fields: {},
    siblingFields: [],
    mcpHost: "127.0.0.1",
    mcpPort: 8181,
    mcpAllowedOrigins: [],
    watchInterval: 300,
    // Same local models QMD uses for reranking and query expansion.
    rerankEnabled: false,
    rerankProvider: "llama",
    rerankGgufRepo: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
    rerankGgufFile: "qwen3-reranker-0.6b-q8_0.gguf",
    rerankCandidates: 30,
    expansionEnabled: false,
    expansionProvider: "llama",
    expansionGgufRepo: "tobil/qmd-query-expansion-1.7B-gguf",
    expansionGgufFile: "qmd-query-expansion-1.7B-q4_k_m.gguf",
    expansionMaxVariants: 4,
  };

  const actualConfigPath = resolveConfigPath(configPath, env);

  // Load the config file if it exists. A missing/unreadable file means
  // defaults; a file that exists but doesn't parse is a user error and must
  // say so instead of silently falling back to defaults.
  let content: string | null = null;
  try {
    content = readFileSync(actualConfigPath, "utf-8");
  } catch {
    // File doesn't exist or can't be read, use defaults
  }
  if (content !== null) {
    const data = parseConfigFile(actualConfigPath, content);

    // openai_api_key is deliberately absent from FILE_MAP: env only.
    for (const [section, key, attr, caster] of FILE_MAP) {
      const sectionData = data[section];
      // A YAML key left empty (`name:`) is null: treat it as unset.
      if (isMapping(sectionData) && key in sectionData && sectionData[key] != null) {
        const value = caster(sectionData[key], `${section}.${key}`);
        cfg[attr] = value as never;
      }
    }

    // A section given a scalar or list (`vault: /my/vault`) would be skipped
    // above and load defaults silently.
    for (const section of SECTIONS) {
      const v = data[section];
      if (v == null) continue;
      if (section === "vaults" ? !Array.isArray(v) : !isMapping(v)) {
        throw new Error(
          section === "vaults"
            ? "config: vaults must be a list (each entry starts with `- `)"
            : `config: ${section} must be a mapping of settings (e.g. \`${section}:\` with keys indented under it)`,
        );
      }
    }

    // Handle frontmatter aliases
    const frontmatterData = data.frontmatter;
    if (isMapping(frontmatterData)) {
      for (const [canonical, aliases] of Object.entries(frontmatterData)) {
        if (canonical in cfg.frontmatter) {
          if (aliases == null) continue; // `id:` left empty: keep the default
          cfg.frontmatter[canonical] = Array.isArray(aliases)
            ? aliases.map((a, i) => str(a, `frontmatter.${canonical}[${i}]`))
            : [str(aliases, `frontmatter.${canonical}`)];
        }
      }
      const fieldsData = frontmatterData.fields;
      if (isMapping(fieldsData)) {
        for (const [key, spec] of Object.entries(fieldsData)) {
          const f = parseFieldSpec(key, spec);
          cfg.fields[key] = f.description;
          if (f.siblings) cfg.siblingFields.push(key);
        }
      }
    }

    // vaults: — several vaults in one index
    if (Array.isArray(data.vaults)) {
      cfg.vaults = (data.vaults as Record<string, unknown>[]).map((v, i) => {
        if (!v || typeof v.path !== "string" || !v.path.trim()) {
          throw new Error(`config: vaults entry ${i + 1} needs a \`path\``);
        }
        const path = v.path;
        const name = v.name == null ? "" : str(v.name, `vaults entry ${i + 1}: name`).trim();
        // Strict: a typo here would silently drop a vault from every
        // unscoped search, the kind of quiet empty result #53 removes.
        if (v.include_by_default !== undefined && typeof v.include_by_default !== "boolean") {
          throw new Error(
            `config: vaults entry ${i + 1}: include_by_default must be true or false`,
          );
        }
        const includeByDefault = v.include_by_default !== false;
        return { name: name || basename(path), path, includeByDefault };
      });
    }
  }

  // Apply env variable overrides
  for (const [envVar, attr, caster] of ENV_MAP) {
    if (envVar in env) {
      const value = caster(env[envVar] as string);
      cfg[attr] = value as never;
    }
  }

  // QKB_VAULT_PATH names ONE vault explicitly — it replaces a configured
  // `vaults` list rather than silently being ignored by it.
  if ("QKB_VAULT_PATH" in env) {
    cfg.vaults = [];
  }

  // Expand ~ in paths
  cfg.vaults = cfg.vaults.map((v) => ({ ...v, path: expandPath(v.path) }));
  const names = new Set<string>();
  for (const v of cfg.vaults) {
    if (names.has(v.name)) throw new Error(`config: duplicate vault name "${v.name}"`);
    names.add(v.name);
  }
  if (cfg.vaults.length > 0 && !cfg.vaults.some((v) => v.includeByDefault)) {
    throw new Error(
      "config: every vaults entry has include_by_default: false — at least one vault must be searched by default",
    );
  }
  if (cfg.vaults.length > 0) {
    // Keep the single-vault fields pointing at the first vault, for callers
    // (and messages) that only care about one.
    cfg.vaultPath = (cfg.vaults[0] as Vault).path;
    cfg.vaultName = (cfg.vaults[0] as Vault).name;
  }
  for (const key of Object.keys(cfg.fields)) {
    for (const aliases of Object.values(cfg.frontmatter)) {
      if (aliases.includes(key)) {
        throw new Error(
          `config: frontmatter.fields "${key}" is already a core frontmatter key or alias`,
        );
      }
    }
  }
  cfg.vaultPath = expandPath(cfg.vaultPath);
  cfg.dbPath = expandPath(cfg.dbPath);
  cfg.modelCacheDir = expandPath(cfg.modelCacheDir);

  return cfg;
}
