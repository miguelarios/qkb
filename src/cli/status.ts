/** `status` command. Ports `status` from `legacy/python/src/qkb/cli.py`,
 * including the "built with" / model-mismatch / interrupted-ingest
 * warnings (git log features #4/#7 of the Python CLI). */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { type Config, configuredVaults, DEFAULT_CONFIG_PATH } from "../config.js";
import { Storage } from "../db/storage.js";
import { getProvider } from "../embed/provider.js";
import { action, cfg, humanSize, mark, openDb } from "./shared.js";

interface StatusPayload {
  config_path: string;
  config_exists: boolean;
  vault_path: string;
  vault_exists: boolean;
  vaults: { name: string; path: string; exists: boolean; documents: number }[];
  fields: Record<string, string>;
  db_path: string;
  db_size_bytes: number;
  provider: string;
  model: string;
  dimension: number;
  /** The identity the configured provider commits to the index (what
   * `qkb embed` records): for `llama` the GGUF stem, not `embedding.model`. */
  provider_model: string;
  provider_dim: number;
  index_model: string | null;
  index_dim: number | null;
  model_mismatch: boolean;
  ingest_interrupted: boolean;
  documents: number;
  chunks: number;
  vectors: number | null;
  dim: number | null;
  contexts: { context: string; count: number; description: string | null }[];
  last_indexed_at: string | null;
}

function humanStatus(cfgObj: Config, p: StatusPayload, dbExists: boolean): string {
  const out: string[] = ["qkb status", ""];
  const found = p.config_exists ? "found" : "using defaults";
  out.push(`Config:   ${p.config_path}  (${found})`);
  if (p.vaults.length > 1) {
    out.push("Vaults:");
    for (const v of p.vaults) {
      out.push(`  ${v.name}: ${v.path}  [${mark(v.exists)}]  (${v.documents} documents)`);
    }
  } else {
    out.push(`Vault:    ${p.vault_path}  (${cfgObj.vaultName})  [${mark(p.vault_exists)}]`);
  }
  if (dbExists) {
    out.push(`Database: ${p.db_path}  (${humanSize(p.db_size_bytes)})`);
  } else {
    out.push(`Database: ${p.db_path}  (no index yet — run \`qkb ingest\`)`);
  }

  out.push("", "Embedding");
  out.push(`  Provider: ${p.provider}`);
  out.push(`  Model:    ${p.model}`);
  out.push(`  Dim:      ${p.dimension}`);
  if (cfgObj.embeddingProvider === "ollama") {
    out.push(`  Host:     ${cfgObj.ollamaHost}`);
  } else if (cfgObj.embeddingProvider === "llama") {
    // Python's distinct "gguf" provider was folded into TS's "llama"
    // default (Task 7 dropped the local/fastembed/gguf split) — this is
    // the direct successor of cli.py's `elif cfg.embedding_provider ==
    // "gguf":` branch, same GGUF-file-cached surfacing, different
    // provider name.
    const cached = existsSync(join(cfgObj.modelCacheDir, cfgObj.localGgufFile));
    out.push(
      `  GGUF:     ${cfgObj.localGgufRepo}/${cfgObj.localGgufFile}  [${mark(cached)} cached]`,
    );
  }

  if (dbExists) {
    const pending = p.chunks - (p.vectors ?? 0);
    out.push("", "Index");
    out.push(`  Documents: ${p.documents}`);
    out.push(`  Chunks:    ${p.chunks}`);
    let vecLine = `  Vectors:   ${p.vectors} embedded  (dim ${p.dim})`;
    if (pending) {
      vecLine += `  (${pending} pending)`;
    }
    out.push(vecLine);
    if (p.index_model !== null) {
      out.push(`  Built with: ${p.index_model}  (dim ${p.index_dim})`);
    }
    out.push(`  Last:      ${p.last_indexed_at ?? "—"}`);
    const names = p.contexts
      .slice(0, 6)
      .map((c) => c.context)
      .join(", ");
    out.push(`  Contexts:  ${p.contexts.length}${names ? `  (${names})` : ""}`);
    const fieldNames = Object.keys(p.fields);
    if (fieldNames.length > 0) {
      out.push(`  Fields:    ${fieldNames.join(", ")}`);
    }
    if (pending) {
      out.push(`  → run \`qkb embed\` to compute the ${pending} pending vector(s)`);
    }
  }
  if (p.model_mismatch && p.index_model !== null) {
    out.push(
      "",
      `⚠ Index was built with '${p.index_model}' (dim ${p.index_dim}) but config now says`,
      `  '${p.provider_model}' (dim ${p.provider_dim}).`,
      "  Run `qkb embed --full` to re-embed with the configured model.",
    );
  }
  if (p.ingest_interrupted) {
    out.push(
      "",
      "⚠ A previous --full re-embed did not complete.",
      "  Run `qkb ingest --full` to finish re-embedding.",
    );
  }
  return out.join("\n");
}

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const cfgObj = cfg();
  const configPath = process.env.QKB_CONFIG || DEFAULT_CONFIG_PATH;
  const dbExists = existsSync(cfgObj.dbPath);
  const storage = dbExists ? new Storage(openDb(cfgObj), cfgObj.vaultName) : null;
  const st = storage ? storage.stats() : null;
  const stored = storage ? storage.storedEmbeddingConfig() : null;
  // Compare against the identity the configured provider would commit — the
  // same value `qkb embed`'s guard checks — not the raw `embedding.model`
  // string: for `llama` the provider's model name is the GGUF stem
  // (e.g. "embeddinggemma-300M-Q8_0"), so comparing the config string made
  // the warning permanent (#29). Constructing a provider does no I/O (no
  // model load, no network); if it can't be built, fall back to config.
  let providerModel = cfgObj.embeddingModel;
  let providerDim = cfgObj.embeddingDim;
  try {
    const provider = await getProvider(cfgObj);
    providerModel = provider.modelName;
    providerDim = provider.dimension;
  } catch {
    // e.g. an unknown provider name — status still reports everything else
  }
  const mismatch = stored !== null && (stored[0] !== providerModel || stored[1] !== providerDim);
  const interrupted = storage ? storage.isIngestInProgress() : false;
  const counts = new Map((storage?.vaultCounts() ?? []).map((c) => [c.vault, c.documents]));

  const payload: StatusPayload = {
    config_path: configPath,
    config_exists: existsSync(configPath),
    vault_path: cfgObj.vaultPath,
    vault_exists: existsSync(cfgObj.vaultPath),
    vaults: configuredVaults(cfgObj).map((v) => ({
      name: v.name,
      path: v.path,
      exists: existsSync(v.path),
      documents: counts.get(v.name) ?? 0,
    })),
    fields: cfgObj.fields,
    db_path: cfgObj.dbPath,
    db_size_bytes: dbExists ? statSync(cfgObj.dbPath).size : 0,
    provider: cfgObj.embeddingProvider,
    model: cfgObj.embeddingModel,
    dimension: cfgObj.embeddingDim,
    provider_model: providerModel,
    provider_dim: providerDim,
    index_model: stored ? stored[0] : null,
    index_dim: stored ? stored[1] : null,
    model_mismatch: mismatch,
    ingest_interrupted: interrupted,
    documents: st?.documents ?? 0,
    chunks: st?.chunks ?? 0,
    vectors: st?.vectors ?? 0,
    dim: st?.dim ?? null,
    contexts: st?.contexts ?? [],
    last_indexed_at: st?.lastIndexedAt ?? null,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(humanStatus(cfgObj, payload, dbExists));
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show embedding model, index, and vault status.")
    .option("--json", "machine-readable output")
    .action(action(runStatus));
}
