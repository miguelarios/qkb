/** SQL filter builders for search. Ported from `legacy/python/src/qkb/search/filters.py`.
 *
 * Filters type + buildFilterClause function for declared/stored fields (case-insensitive;
 * `context`/`source` are shorthand for a field filter on that key),
 * source, type, tags (AND semantics via junction table), date range (with expansion
 * of partial dates like "2026" to full ISO YYYY-MM-DD bounds).
 */

import { placeholders } from "../db/schema.js";
import { parseDateLenient } from "../ingest/parser.js";
import { SearchValidationError } from "./errors.js";

/**
 * Search filter criteria. All fields optional; omitted/null fields generate no
 * WHERE condition. Ported from `qkb.search.filters.Filters`.
 */
export class Filters {
  context: string | undefined;
  source: string | undefined;
  docType: string | undefined;
  tags: string[] | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  /** Restrict to these vault names (OR). */
  vaults: string[] | undefined;
  /** Declared-field equality filters (AND across keys). A value matches the
   * whole stored value or one item of a list value, case-insensitively. */
  fields: Record<string, string> | undefined;

  constructor(init: Partial<Filters> = {}) {
    this.context = init.context;
    this.source = init.source;
    this.docType = init.docType;
    this.tags = init.tags;
    this.dateFrom = init.dateFrom;
    this.dateTo = init.dateTo;
    this.vaults = init.vaults;
    this.fields = init.fields;
  }
}

/** Year pattern: `\d{4}` (4 digits, no separators). */
const YEAR_RE = /^\d{4}$/;

/** Year-month pattern: `\d{4}-\d{2}` (extended format only). */
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * Expand a possibly-partial date bound to a full ISO YYYY-MM-DD.
 *
 * A bare year or year-month is expanded to the first/last day of the period
 * depending on whether it's a lower (`upper=false`) or upper (`upper=true`)
 * bound, so partial dates keep working against the lexicographically-comparable
 * canonical `effective_date` column (finding 8) instead of hard-erroring or
 * mis-comparing.
 *
 * Ported from `legacy/python/src/qkb/search/filters._normalize_bound`.
 */
function normalizeBound(label: string, value: string | undefined, upper: boolean): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const v = value.trim();
  if (!v) {
    throw new SearchValidationError(`${label}: unparseable date ${JSON.stringify(value)}`);
  }

  if (YEAR_RE.test(v)) {
    const y = parseInt(v, 10);
    if (upper) {
      return `${y.toString().padStart(4, "0")}-12-31`;
    }
    return `${y.toString().padStart(4, "0")}-01-01`;
  }

  const m = YEAR_MONTH_RE.exec(v);
  if (m) {
    const [, yStr = "", moStr = ""] = m;
    const y = parseInt(yStr, 10);
    const mo = parseInt(moStr, 10);
    if (mo < 1 || mo > 12) {
      throw new SearchValidationError(`${label}: unparseable date ${JSON.stringify(value)}`);
    }
    // Get the last day of the month if upper bound, else day 1
    let day: number;
    if (upper) {
      // Day 0 of next month gives us the last day of the current month
      day = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    } else {
      day = 1;
    }
    return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }

  // Try lenient parsing (handles full ISO dates, timestamps, etc.)
  const parsed = parseDateLenient(v);
  if (parsed === null) {
    throw new SearchValidationError(`${label}: unparseable date ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Build a WHERE clause and parameters from a Filters object.
 *
 * Returns `[clause, params]` where clause is a SQL snippet (e.g.
 * `"d.context = ? AND d.source = ?"`) and params is an array of bound values.
 * Empty filters return `["1=1", []]` (no-op clause).
 *
 * Semantics:
 * - context / source: shorthand for a field filter on that key (#35);
 *   empty/whitespace-only raises
 * - source: stripped only (NOT lowercased); empty/whitespace-only raises
 * - docType: stored as "type" in DB, used as-is
 * - tags: AND-semantics via junction table: `d.id IN (SELECT ... WHERE tag IN
 *   (...) GROUP BY document_id HAVING COUNT(DISTINCT tag) = len(tags))`
 * - dateFrom/dateTo: expanded (partial dates -> full ISO), then >= / <=
 *
 * Ported from `legacy/python/src/qkb/search/filters.build_filter_clause`.
 */
export function buildFilterClause(f: Filters): [string, unknown[]] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // `context` / `source` are ordinary properties now (#35): these legacy
  // filters are shorthand for a field filter on that key, matched against
  // the stored property whether or not it is declared.
  const fieldFilters: Record<string, string> = { ...(f.fields ?? {}) };
  for (const [key, value] of [
    ["context", f.context],
    ["source", f.source],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (!value.trim()) {
      throw new SearchValidationError(`${key} filter is empty or whitespace-only`);
    }
    fieldFilters[key] = value;
  }

  if (f.docType) {
    // Truthiness check: skip undefined, null, and empty string (matching Python's `if f.doc_type:`)
    conditions.push("d.type = ?");
    params.push(f.docType);
  }

  const dateFrom = normalizeBound("date_from", f.dateFrom, false);
  if (dateFrom !== null) {
    conditions.push("d.effective_date >= ?");
    params.push(dateFrom);
  }

  const dateTo = normalizeBound("date_to", f.dateTo, true);
  if (dateTo !== null) {
    conditions.push("d.effective_date <= ?");
    params.push(dateTo);
  }

  if (f.tags !== undefined && f.tags !== null && f.tags.length > 0) {
    const marks = placeholders(f.tags.length);
    conditions.push(
      `d.id IN (SELECT document_id FROM tags WHERE tag IN (${marks}) ` +
        "GROUP BY document_id HAVING COUNT(DISTINCT tag) = ?)",
    );
    params.push(...f.tags);
    params.push(f.tags.length);
  }

  if (f.vaults !== undefined && f.vaults !== null && f.vaults.length > 0) {
    const names = f.vaults.map((v) => v.trim());
    if (names.some((v) => !v)) {
      throw new SearchValidationError("vault filter is empty or whitespace-only");
    }
    conditions.push(`d.vault_name IN (${placeholders(names.length)})`);
    params.push(...names);
  }

  if (Object.keys(fieldFilters).length > 0) {
    for (const [key, raw] of Object.entries(fieldFilters)) {
      const value = String(raw).trim().toLowerCase();
      if (!key.trim() || !value) {
        throw new SearchValidationError(`field filter ${JSON.stringify(key)} is empty`);
      }
      // List values are stored joined with ", " (parser's `stringify`), so a
      // single item matches when it's one of the comma-separated entries.
      conditions.push(
        "EXISTS (SELECT 1 FROM metadata m WHERE m.document_id = d.id AND m.key = ? AND " +
          "(lower(m.value) = ? OR (', ' || lower(m.value) || ', ') LIKE ? ESCAPE '\\'))",
      );
      const escaped = value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      params.push(key.trim(), value, `%, ${escaped}, %`);
    }
  }

  const clause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
  return [clause, params];
}
