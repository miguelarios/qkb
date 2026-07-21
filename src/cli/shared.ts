/** Shared helpers for CLI command implementations — config/db access, search
 * filter construction, result emission, and clean error exit helpers.
 *
 * Ports the small shared functions at the top of `legacy/python/src/qkb/cli.py`
 * (`_cfg`, `_conn`, `_filters`, `_emit`, `search_options`, `_human_size`,
 * `_shorten`) into TS/commander idioms.
 */
import { spawn } from "node:child_process";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { type Config, loadConfig } from "../config.js";
import { connect } from "../db/schema.js";
import { Filters } from "../search/filters.js";
import type { HydratedResult } from "../search/hydrate.js";

export function cfg(): Config {
  return loadConfig();
}

export function openDb(cfgObj: Config): Database.Database {
  return connect(cfgObj.dbPath, cfgObj.embeddingDim);
}

/** Raw commander-parsed option values for the shared search flags — strings
 * throughout (commander doesn't coerce), converted by `filtersFromOpts`/
 * `limitFromOpts` below. */
export interface SearchOpts {
  context?: string;
  source?: string;
  type?: string;
  tags?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: string;
  json?: boolean;
  files?: boolean;
}

/** Adds the shared search filter/output flags every search-tier command
 * (`search`, `vsearch`, `query`) takes. Ports cli.py's `search_options`
 * decorator. */
export function addSearchOptions(cmd: Command): Command {
  return cmd
    .option("--context <context>", "filter by context")
    .option("--source <source>", "filter by source")
    .option("--type <type>", "filter by document type")
    .option("--tags <tags>", "comma-separated, AND semantics")
    .option("--date-from <date>", "filter: effective date >= this")
    .option("--date-to <date>", "filter: effective date <= this")
    .option("--limit <n>", "max results")
    .option("--json", "output as JSON")
    .option("--files", "output as document_id,score,file_path,context lines");
}

/** Ports cli.py's `_filters`. */
export function filtersFromOpts(opts: SearchOpts): Filters {
  return new Filters({
    context: opts.context,
    source: opts.source,
    docType: opts.type,
    tags: opts.tags
      ? opts.tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : undefined,
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
  });
}

/** `null` (-> `cfg.defaultLimit`) when `--limit` wasn't passed, else the raw
 * (possibly invalid — `executeSearch` validates) numeric value. */
export function limitFromOpts(opts: SearchOpts): number | null {
  return opts.limit !== undefined ? Number(opts.limit) : null;
}

function renderTable(results: HydratedResult[]): void {
  const columns: { header: string; get: (r: HydratedResult) => string }[] = [
    { header: "Title", get: (r) => r.title ?? "" },
    { header: "Type", get: (r) => r.type },
    { header: "Context", get: (r) => r.context ?? "-" },
    { header: "Date", get: (r) => r.effective_date },
    { header: "Score", get: (r) => r.score.toFixed(4) },
  ];
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...results.map((r) => col.get(r).length)),
  );
  const renderRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(renderRow(columns.map((c) => c.header)));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of results) {
    console.log(renderRow(columns.map((c) => c.get(r))));
  }
  for (const r of results) {
    if (r.matched_text) {
      console.log(`${r.title ?? ""}: ${r.matched_text.slice(0, 200)}`);
    }
  }
}

/** Emits search results as JSON, CSV-like file lines, or a human table.
 * Ports cli.py's `_emit`. */
export function emit(results: HydratedResult[], asJson: boolean, asFiles: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (asFiles) {
    for (const r of results) {
      console.log(`${r.document_id},${r.score},${r.file_path},${r.context ?? ""}`);
    }
    return;
  }
  renderTable(results);
}

/** Truncate a path to its most useful tail (filename + nearest folder), used
 * as the current-file label in the ingest progress bar. Ports cli.py's
 * `_shorten`. */
export function shorten(path: string, width = 44): string {
  return path.length <= width ? path : `…${path.slice(-(width - 1))}`;
}

/** Ports cli.py's `_human_size`. */
export function humanSize(n: number): string {
  let size = n;
  const units = ["B", "KB", "MB", "GB"];
  for (const unit of units) {
    if (size < 1024 || unit === "GB") {
      return unit === "B" ? `${size.toFixed(0)} ${unit}` : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} GB`;
}

export function mark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

/** Print a clean, one-line usage error (bad filter/limit/argument) and exit
 * 2 — mirrors Click's `UsageError` exit code. */
export function failUsage(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

/** Print a clean, one-line runtime error and exit 1 — mirrors Click's
 * `ClickException` exit code. */
export function failRuntime(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wraps a commander action so any error it throws prints a clean one-line
 * message — never a raw stack trace — and exits non-zero.
 *
 * This is deliberately broader than Python: cli.py only wraps specific
 * exception types per-command (ValueError in `_do_search`, RuntimeError in
 * `embed`, three types in `get`); anything else in Python crashes with a
 * traceback. The task's global "clean errors, no stack traces" acceptance
 * criterion applies to the whole CLI, not just those specific paths, so this
 * wrapper is a deliberate strengthening — every action gets a safety net on
 * top of its own typed-error handling. See ts-task-15-report.md.
 */
export function action<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(`Error: ${errorMessage(e)}`);
      process.exit(1);
    }
  };
}

/** Best-effort cross-platform "open this URL/file in the default handler",
 * mirroring Python's `webbrowser.open()` (used by `get --open`). Not on the
 * critical path of `get`, so failures are swallowed rather than surfaced. */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort; opening a browser is not on the critical path of `get`
  }
}
