/** `init` command: write a starter `config.yaml` when none exists.
 *
 * Used directly (`qkb init --vault ~/Notes`) and by the container image's
 * entrypoint, which seeds `/config/config.yaml` on first start so there is a
 * file to edit. It never replaces an existing config unless `--force`. */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
// Default import: js-yaml v3 is CJS — see the note in src/ingest/parser.ts.
import yaml from "js-yaml";
import { resolveConfigPath } from "../config.js";
import { action, failUsage } from "./shared.js";

export interface StarterVault {
  name: string;
  path: string;
}

/** `Name=/path`, or a bare `/path` named after its last segment. */
export function parseVaultArg(arg: string): StarterVault {
  const eq = arg.indexOf("=");
  const name = eq > 0 ? arg.slice(0, eq).trim() : "";
  const path = (eq > 0 ? arg.slice(eq + 1) : arg).trim();
  if (!path) failUsage(`--vault needs a path, got "${arg}"`);
  return { name: name || basename(path) || "Notes", path };
}

/** Each subdirectory of `dir` as a vault named after it (dot-directories
 * skipped). A missing or unreadable `dir` yields none. */
export function discoverVaults(dir: string): StarterVault[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith("."))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((n) => ({ name: n, path: join(dir, n) }));
}

/** A YAML scalar that reads back as the same string (quoted when needed). */
function scalar(s: string): string {
  return yaml.safeDump(s, { lineWidth: -1 }).trim();
}

/** The starter config: the given vaults, the default embedding provider, and
 * the other settings worth knowing about as commented examples. */
export function starterConfig(vaults: StarterVault[]): string {
  const list = vaults.length > 0 ? vaults : [{ name: "Notes", path: "~/Notes" }];
  const entries = list
    .map((v) => `  - name: ${scalar(v.name)}\n    path: ${scalar(v.path)}`)
    .join("\n");
  return `# qkb configuration. Every setting is optional; commented lines are examples.
# Reference: https://github.com/miguelarios/qkb#configuration-reference
# qkb reads this file at startup: restart it (or its container) after editing.

# Folders of markdown notes to index. \`name\` is the Obsidian vault name, used
# in obsidian:// links. In a container, \`path\` is the path inside the
# container (where the folder is mounted), not the path on the host.
vaults:
${entries}
  # - name: Work
  #   path: /vaults/Work
  #   include_by_default: false   # searched only when a search names it

# Where embeddings are computed. After changing provider or model, re-embed
# with \`qkb embed --full\`.
embedding:
  # In-process GGUF model, downloaded on first use. No other service needed.
  provider: llama
  # model: embeddinggemma-300M-Q8_0
  # dimension: 768

  # An Ollama server (from a container, the host machine is
  # host.docker.internal):
  # provider: ollama
  # model: embeddinggemma
  # dimension: 768
  # ollama_host: http://host.docker.internal:11434

  # Any OpenAI-compatible /v1/embeddings endpoint. The API key comes from the
  # QKB_OPENAI_API_KEY environment variable, never from this file.
  # provider: openai
  # model: text-embedding-3-small
  # dimension: 1536
  # openai_base_url: https://api.openai.com

# Extra frontmatter properties to search, return and describe to agents.
# frontmatter:
#   fields:
#     project: Project this note belongs to

# Seconds between re-index runs (\`qkb mcp --watch\`, \`qkb watch\`).
# watch:
#   interval: 300

# Optional local models that re-score results / rewrite queries (slower).
# rerank:
#   enabled: true
# expansion:
#   enabled: true
`;
}

interface InitOpts {
  vault?: string[];
  vaultsDir?: string;
  force?: boolean;
  quiet?: boolean;
}

function runInit(opts: InitOpts): void {
  const path = resolveConfigPath();
  if (existsSync(path) && !opts.force) {
    if (!opts.quiet) console.log(`Config already exists: ${path} (use --force to replace it)`);
    return;
  }
  const vaults = [
    ...(opts.vaultsDir ? discoverVaults(opts.vaultsDir) : []),
    ...(opts.vault ?? []).map(parseVaultArg),
  ];
  const names = new Set<string>();
  for (const v of vaults) {
    if (names.has(v.name)) {
      failUsage(`two vaults are named "${v.name}" — name one of them with --vault Name=/path`);
    }
    names.add(v.name);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, starterConfig(vaults));
  // stderr: a server started right after this may own stdout (MCP stdio).
  console.error(`qkb: wrote a starter config to ${path}`);
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Write a starter config.yaml if none exists")
    .option(
      "--vault <[name=]path>",
      "a vault to list in the config (repeatable)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--vaults-dir <dir>", "list every subdirectory of <dir> as a vault")
    .option("--force", "replace an existing config")
    .option("--quiet", "say nothing when a config already exists")
    .action(action(runInit));
}
