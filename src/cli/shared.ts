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
import { Storage } from "../db/storage.js";
import {
  hasMatchMarkers,
  queryTokens,
  stripMarkersWhere,
  toPublicMarkers,
} from "../search/bm25.js";
import { Filters } from "../search/filters.js";
import type { HydratedResult } from "../search/hydrate.js";

/** The three search tiers `doSearch` (src/cli/search.ts) runs — threaded
 * through to the human-output renderer so marker-less matched_text can be
 * interpreted correctly (see `evidenceLine`'s docstring below). */
export type SearchTier = "bm25" | "vector" | "hybrid";

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

/** Score column: a percentage relative to the top (first, best-ranked)
 * result — top is always 100%, everything else rounded to the nearest
 * integer percent of the top score. Raw scores (BM25's unbounded values,
 * hybrid RRF's tiny decimals — see cli/search.ts's doc comment and
 * issue #14) are unreadable as printed table cells; `--json`/`--files`
 * still emit `r.score` untouched, this only affects the human table.
 *
 * `results` is already sorted best-first (hydrate preserves `runSearch`'s
 * order), so `results[0]` is always the top score. Vector scores are
 * `1 - cosine distance` (vector.ts), which is negative for a dissimilar
 * chunk — a plain ratio would print a nonsensical negative percentage for
 * those (`score / top` with a negative numerator and positive top), so the
 * result is clamped to `[0, 100]`: nothing scores "worse than 0% similar to
 * the top result" or, from float rounding on near-ties, "better than the
 * top result". `top <= 0` (a degenerate all-non-positive score list) falls
 * back to a binary 100/0 by equality to `top`, since a ratio against a
 * non-positive denominator isn't meaningful. */
export function relativeScorePercents(results: HydratedResult[]): number[] {
  const top = results[0]?.score ?? 0;
  if (top <= 0) {
    return results.map((r) => (r.score === top ? 100 : 0));
  }
  return results.map((r) => Math.max(0, Math.min(100, Math.round((r.score / top) * 100))));
}

/** When `matched_text` has no match markers, the match (if any) landed in
 * a metadata column FTS5 doesn't snippet — figure out which one so the CLI
 * can print `matched: <field> "<value>"` instead of a noisy, useless
 * document-head snippet. Checks the query's `\w+` tokens (same tokenizer
 * `sanitizeQuery` uses — see bm25.ts's `queryTokens`) case-insensitively
 * against title/tags/context/type, in the same priority order as those
 * columns' FTS weights (bm25.ts's `fts_weights`: title, tags, context, ...,
 * type) — a title hit is reported over a context hit if the query token
 * appears in both, mirroring which column actually drove the ranking most.
 * `null` when nothing is identifiable (issue #14: print nothing rather than
 * noise in that case). */
export function matchAttribution(result: HydratedResult, query: string): string | null {
  const tokens = queryTokens(query).map((t) => t.toLowerCase());
  if (tokens.length === 0) {
    return null;
  }
  const hits = (value: string | null | undefined): value is string =>
    Boolean(value) && tokens.some((t) => (value as string).toLowerCase().includes(t));
  if (hits(result.title)) {
    return `matched: title "${result.title}"`;
  }
  const tag = result.tags.find((t) => hits(t));
  if (tag !== undefined) {
    return `matched: tag "${tag}"`;
  }
  if (hits(result.context)) {
    return `matched: context "${result.context}"`;
  }
  if (hits(result.type)) {
    return `matched: type "${result.type}"`;
  }
  return null;
}

/** Collapse internal whitespace, then clip to `maxWidth` at a word boundary
 * (never mid-word) with a trailing `…`. Used for both `matched_text`
 * snippets and the attribution line so a long context/title value can't
 * blow past the terminal width either. */
export function clipAtWordBoundary(text: string, maxWidth: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (maxWidth <= 1 || collapsed.length <= maxWidth) {
    return collapsed;
  }
  const truncated = collapsed.slice(0, maxWidth - 1); // reserve a column for the ellipsis
  const lastSpace = truncated.lastIndexOf(" ");
  const clipped = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${clipped}…`;
}

/** stdout column width to clip evidence lines to. Non-TTY (piped output,
 * every subprocess test in test/cli.test.ts) reports `columns` as
 * `undefined` — falls back to a fixed 80, matching the conventional
 * terminal default and keeping clipping deterministic under test. */
function terminalWidth(): number {
  const cols = process.stdout.columns;
  return cols !== undefined && cols > 20 ? cols : 80;
}

// A small standard English stopword list (articles, auxiliary/copula verbs,
// pronouns, prepositions, conjunctions, common question/quantifier words) —
// no equivalent list exists elsewhere in this repo or in `legacy/` (checked
// before adding this; `legacy/python/src/qkb` has no stopword handling at
// all — ranking has always weighted these the same as any other token, this
// is purely a render-time display filter). Deliberately NOT the search
// index's vocabulary and NOT stemmed/lemmatized: only an EXACT (lowercased)
// token match strips a marker, so e.g. `[saying]` stays marked (`saying` is
// not itself on this list, even though "say" is) — a conservative choice
// that only strips uncontroversial function words, never risking hiding a
// real content-word hit. See `stripStopwordMarkers` below.
const STOPWORDS = new Set([
  // articles / determiners
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  // conjunctions
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "nor",
  "so",
  "yet",
  "because",
  // to be / to do / to have (aux + copula, uninflected and common inflections)
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "having",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  // pronouns
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "mine",
  "yours",
  "hers",
  "ours",
  "theirs",
  "who",
  "whom",
  "whose",
  "what",
  "which",
  // prepositions
  "of",
  "in",
  "on",
  "at",
  "by",
  "to",
  "from",
  "with",
  "about",
  "against",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "once",
  // misc common function words
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "now",
]);

function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

/** Strips the marker pair around any EXACT-match stopword hit in a
 * `matched_text` snippet, keeping the word's own text in place — the query
 * token itself decides this, not the enclosing sentence, so `[the]`/`[what]`/
 * `[about]` lose their markers while a real content-word hit like `[alice]`
 * or `[doctor]` keeps its markers. A no-op on marker-less text. Delegates
 * the actual marker-bytes bookkeeping to `bm25.ts`'s `stripMarkersWhere` —
 * this module only supplies the stopword predicate. */
export function stripStopwordMarkers(text: string): string {
  return stripMarkersWhere(text, isStopword);
}

/**
 * Builds the single indented evidence line printed under a human-table row,
 * or `null` to print nothing for that result. Ports issue #14's "match
 * evidence" behavior:
 *
 * - `matched_text` is null (no match text at all, e.g. RRF fused in a doc
 *   whose legs both came up empty-stringed): nothing.
 * - has match markers (bm25.ts's `hasMatchMarkers` — internal control
 *   chars, NOT literal `[`/`]`; markdown checklists/wikilinks routinely
 *   contain real brackets that aren't a match, so bracket-sniffing would
 *   misfire — see bm25.ts's module comment): first `stripStopwordMarkers`
 *   removes the marker pair around any EXACT stopword hit (a real-vault
 *   natural-language query like "what did the doctor say about alice"
 *   otherwise highlights `[what] [did] ... [about]` — informationless
 *   confetti around the one or two content words that actually matter).
 *   If at least one marker survives stripping, print that (clip + translate
 *   to `[`/`]` for display, readable in plain text, no ANSI requirement).
 * - stripping removed EVERY marker (only stopwords matched) — treated
 *   exactly like marker-less text below, since there's no real evidence
 *   left worth highlighting.
 * - no markers (never had any, or stripped down to none), but
 *   `matchAttribution` identifies a metadata column: print that attribution
 *   instead of the noisy document-head snippet.
 * - no markers and nothing identifiable: for `bm25`, that marker-less text
 *   IS the document-head noise the issue calls out — print nothing. For
 *   `vector` it's never noise: vector search has no metadata columns at
 *   all, so `matched_text` is always genuine chunk text — clip and print
 *   it unconditionally. `hybrid` is ambiguous by construction (hybrid.ts's
 *   `search()` prefers vector chunk text and only falls back to the bm25
 *   snippet when a doc has no vector leg hit) — since dropping real vector
 *   chunk text here would be a regression (the only evidence for that
 *   result, silently hidden), hybrid degrades the same way `vector` does
 *   rather than the same way `bm25` does.
 */
function evidenceLine(
  r: HydratedResult,
  query: string,
  tier: SearchTier,
  width: number,
): string | null {
  const raw = r.matched_text;
  if (!raw) {
    return null;
  }
  const avail = Math.max(10, width - 2); // 2-column indent printed below
  // Only text that actually HAS markers needs the stopword pass — a no-op
  // call is harmless either way (stripMarkersWhere already no-ops on
  // marker-less text), but skipping it when there's nothing to strip keeps
  // `text === raw` (not just equal-by-value) for the vector/hybrid chunk
  // text case below.
  const text = hasMatchMarkers(raw) ? stripStopwordMarkers(raw) : raw;
  if (hasMatchMarkers(text)) {
    // At least one non-stopword marker survived stripping — real evidence.
    return clipAtWordBoundary(toPublicMarkers(text), avail);
  }
  // No markers at all: either never had any (metadata-only bm25 match, or
  // vector/hybrid chunk text), or stripping just removed every one of them
  // (only stopwords matched) — both degrade the same way.
  const attribution = matchAttribution(r, query);
  if (attribution) {
    return clipAtWordBoundary(attribution, avail);
  }
  if (tier === "bm25") {
    return null;
  }
  return clipAtWordBoundary(text, avail);
}

/** Wraps `uri` in the ANSI SGR "dim" sequence when stdout is a TTY, so it
 * doesn't visually compete with the evidence line above it while still
 * being a plain, terminal-linkifiable/cmd-clickable `obsidian://...` string
 * — degrades to plain text on a non-TTY (piped output, every subprocess
 * test in test/cli.test.ts), matching this codebase's existing convention
 * of no ANSI in non-interactive output (see progress.ts's module docstring
 * for the same rule applied to the ingest/embed progress bar). */
function dimIfTty(uri: string): string {
  return process.stdout.isTTY === true ? `\u001b[2m${uri}\u001b[22m` : uri;
}

function renderTable(results: HydratedResult[], query: string, tier: SearchTier): void {
  const percents = relativeScorePercents(results);
  const columns: { header: string; get: (r: HydratedResult, i: number) => string }[] = [
    { header: "Title", get: (r) => r.title ?? "" },
    { header: "Type", get: (r) => r.type },
    { header: "Context", get: (r) => r.context ?? "-" },
    { header: "Date", get: (r) => r.effective_date },
    { header: "Score", get: (_r, i) => `${percents[i] ?? 0}%` },
  ];
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...results.map((r, i) => col.get(r, i).length)),
  );
  const renderRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(renderRow(columns.map((c) => c.header)));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  const width = terminalWidth();
  results.forEach((r, i) => {
    console.log(renderRow(columns.map((c) => c.get(r, i))));
    const line = evidenceLine(r, query, tier, width);
    if (line) {
      console.log(`  ${line}`);
    }
    // Owner-feedback follow-up to issue #14: hydrate already computes
    // `obsidian_uri` (it's on --json today), but the human table never
    // showed it — the full, unclipped URI (never width-clipped: it must
    // stay a valid, clickable link) as a second indented line after the
    // evidence line, so a terminal that linkifies `obsidian://` URIs (or
    // supports cmd/ctrl-click) can jump straight to the note. Human output
    // only — --json/--files/MCP already carry `obsidian_uri` unchanged.
    console.log(`  ${dimIfTty(r.obsidian_uri)}`);
  });
}

/** Emits search results as JSON, CSV-like file lines, or a human table.
 * Ports cli.py's `_emit`. `query`/`tier` are only used by the human table
 * (relative scores + per-result evidence lines, issue #14) — `--json`
 * still serializes `r.score` untouched and `--files` never touches score
 * formatting at all, so neither needs them.
 *
 * `--json`'s `matched_text` is translated back to the public `[`/`]`
 * markers (bm25.ts's `toPublicMarkers`) before serializing: internally
 * `matched_text` may carry the control-char markers `searchBm25` now emits
 * (issue #14 critical fix — bracket-sniffing for "was this a real match"
 * broke on markdown checklists/wikilinks), but the JSON contract is public
 * API (Python parity) and must stay byte-identical to before that change.
 * `--files` never includes `matched_text` at all, so it needs no
 * translation. */
export function emit(
  results: HydratedResult[],
  asJson: boolean,
  asFiles: boolean,
  query: string,
  tier: SearchTier,
): void {
  if (asJson) {
    const publicResults = results.map((r) => ({
      ...r,
      matched_text: r.matched_text !== null ? toPublicMarkers(r.matched_text) : null,
    }));
    console.log(JSON.stringify(publicResults, null, 2));
    return;
  }
  if (asFiles) {
    for (const r of results) {
      console.log(`${r.document_id},${r.score},${r.file_path},${r.context ?? ""}`);
    }
    return;
  }
  renderTable(results, query, tier);
}

/** Prints a one-line stderr tip when the ORIGINAL (trimmed, lowercased)
 * query string exactly matches an existing context's name — e.g. `qkb
 * search homelab-traefik` when "homelab-traefik" is a context, which
 * otherwise silently degrades into "browse that context ranked by the
 * context FTS column" (issue #14, gap 3) rather than the term-search the
 * user likely meant. Human output only (never `--json`/`--files` — callers
 * gate that) and only when there ARE results to show (an empty result list
 * already got its own "no results" signal; piling a second hint on top of
 * that is noise, not help). Contexts are stored trim+lowercased already
 * (`normalizeContext`, src/ingest/parser.ts) so the comparison needs no
 * further normalization on that side. One cheap indexed existence check
 * (`Storage.hasContext`, `idx_documents_context`) per search — deliberately
 * NOT `listContexts()`'s full `GROUP BY` aggregation over every document,
 * which this only needs a yes/no answer from. */
export function printContextHint(
  conn: Database.Database,
  query: string,
  resultCount: number,
): void {
  if (resultCount === 0) {
    return;
  }
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return;
  }
  if (new Storage(conn).hasContext(trimmed)) {
    console.error(`tip: "${trimmed}" is a context — use --context ${trimmed} to browse it`);
  }
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
