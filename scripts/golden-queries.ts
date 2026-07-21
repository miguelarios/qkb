#!/usr/bin/env node
/**
 * Golden-query acceptance harness (PRD success metric: >=8/10 in top 3).
 *
 * Usage: npm run golden-queries -- [path-to-yaml]
 *        tsx scripts/golden-queries.ts [path-to-yaml]
 *
 * Requires an ingested + embedded database (`qkb ingest && qkb embed`) and,
 * for non-`fake` providers, the configured embedding backend available
 * (Ollama running, OpenAI-compatible endpoint reachable, or the llama GGUF
 * cached). Reads the OWNER'S PRIVATE `~/.config/qkb/golden_queries.yaml` by
 * default — that file contains real vault titles/queries and must NEVER be
 * committed or copied into this repo (see
 * `legacy/python/scripts/golden_queries.example.yaml` for the schema this
 * expects, with synthetic examples). Task 18 (manual acceptance) runs this
 * against the owner's real vault; unit tests here exercise the scoring/
 * parsing logic against synthetic fixtures with `FakeProvider`.
 *
 * Ported from `legacy/python/scripts/golden_queries.py`, same scoring
 * definition (target doc title-substring in the hybrid top-3) and summary
 * output shape (`N/10 in top 3 (target: >=80%)`). Python hand-rolled a
 * regex YAML subset parser to avoid a dependency; this uses `js-yaml`
 * (already a qkb dependency — see `src/ingest/parser.ts`) for a real parse.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
// Default import, not `* as yaml`: js-yaml v3 is CJS — see src/ingest/parser.ts
// for the full explanation of why a namespace import breaks under real
// Node ESM/CJS interop.
import yaml from "js-yaml";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { getProvider } from "../src/embed/provider.js";
import type { EmbeddingProvider } from "../src/embed/types.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";

export const DEFAULT_GOLDEN_QUERIES_PATH = join(homedir(), ".config", "qkb", "golden_queries.yaml");

/** One entry from the golden-queries YAML: a query, the title substring
 * expected somewhere in the top-3 hybrid results, and an optional context
 * filter. Mirrors the dict shape Python's `load_queries` produced. */
export interface GoldenQuery {
  query: string;
  expect_title_contains: string;
  context?: string;
}

/**
 * Parses the golden-queries YAML file (`{queries: [{query,
 * expect_title_contains, context?}, ...]}`, see
 * `legacy/python/scripts/golden_queries.example.yaml`). Throws if an entry
 * is missing a required field, so a malformed file fails loudly instead of
 * silently skipping queries the way a partial regex match might.
 */
export function parseGoldenQueries(yamlText: string): GoldenQuery[] {
  const data = yaml.load(yamlText) as { queries?: unknown } | null | undefined;
  const raw = data?.queries;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("golden queries file: top-level `queries` must be a list");
  }
  return raw.map((item, i) => {
    const q = (item ?? {}) as Record<string, unknown>;
    if (typeof q.query !== "string" || typeof q.expect_title_contains !== "string") {
      throw new Error(
        `golden queries file: entry ${i} is missing required "query"/"expect_title_contains" ` +
          `string fields: ${JSON.stringify(item)}`,
      );
    }
    const entry: GoldenQuery = { query: q.query, expect_title_contains: q.expect_title_contains };
    if (typeof q.context === "string") {
      entry.context = q.context;
    }
    return entry;
  });
}

/** Per-query outcome: whether `expect_title_contains` (case-insensitive)
 * appeared in one of the hybrid top-3 titles, and those titles for
 * reporting. */
export interface GoldenQueryOutcome {
  query: string;
  ok: boolean;
  titles: (string | null)[];
}

/**
 * Runs every golden query through the hybrid tier (top 3) and scores a hit
 * when `expect_title_contains` (case-insensitive) is a substring of one of
 * the top-3 titles. Ported from golden_queries.py's per-query loop in
 * `main()` — same tier ("hybrid"), same limit (3), same case-insensitive
 * substring match.
 */
export async function runGoldenQueries(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider,
  queries: GoldenQuery[],
): Promise<GoldenQueryOutcome[]> {
  const outcomes: GoldenQueryOutcome[] = [];
  for (const q of queries) {
    const results = await executeSearch(
      conn,
      cfg,
      provider,
      q.query,
      new Filters({ context: q.context }),
      3,
      "hybrid",
    );
    const titles = results.map((r) => r.title);
    const needle = q.expect_title_contains.toLowerCase();
    const ok = titles.some((t) => (t ?? "").toLowerCase().includes(needle));
    outcomes.push({ query: q.query, ok, titles });
  }
  return outcomes;
}

/** Formats PASS/FAIL lines + the `N/total in top 3 (target: >=80%)` summary,
 * mirroring golden_queries.py's `print()` output line-for-line in spirit. */
export function formatReport(outcomes: GoldenQueryOutcome[]): string {
  const lines = outcomes.map((o) => {
    const titles = `[${o.titles.map((t) => JSON.stringify(t)).join(", ")}]`;
    return `${o.ok ? "PASS" : "FAIL"}  ${JSON.stringify(o.query)} -> ${titles}`;
  });
  const hits = outcomes.filter((o) => o.ok).length;
  lines.push("", `${hits}/${outcomes.length} in top 3 (target: >=80%)`);
  return lines.join("\n");
}

/** Ports golden_queries.py's exit-code rule: pass (0) only when there's at
 * least one query and the hit rate is >= 80%. */
export function scorePassed(outcomes: GoldenQueryOutcome[]): boolean {
  if (outcomes.length === 0) {
    return false;
  }
  return outcomes.filter((o) => o.ok).length / outcomes.length >= 0.8;
}

async function main(): Promise<number> {
  const path = process.argv[2] ?? DEFAULT_GOLDEN_QUERIES_PATH;
  const cfg = loadConfig();
  const conn = connect(cfg.dbPath, cfg.embeddingDim);
  const provider = await getProvider(cfg);
  try {
    const queries = parseGoldenQueries(readFileSync(path, "utf-8"));
    const outcomes = await runGoldenQueries(conn, cfg, provider, queries);
    console.log(formatReport(outcomes));
    return scorePassed(outcomes) ? 0 : 1;
  } finally {
    provider.close?.();
    conn.close();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    });
}
