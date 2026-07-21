/** SQL filter builders for search. Ported from `legacy/python/src/qkb/search/filters.py`.
 *
 * Filters type + buildFilterClause function for context (normalized, case-insensitive),
 * source, type, tags (AND semantics via junction table), date range (with expansion
 * of partial dates like "2026" to full ISO YYYY-MM-DD bounds).
 */

import { placeholders } from "../db/schema.js";
import { normalizeContext, parseDateLenient } from "../ingest/parser.js";
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

  constructor(init: Partial<Filters> = {}) {
    this.context = init.context;
    this.source = init.source;
    this.docType = init.docType;
    this.tags = init.tags;
    this.dateFrom = init.dateFrom;
    this.dateTo = init.dateTo;
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
 * - context: normalized via `normalizeContext()` (case-insensitive, trimmed);
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

  if (f.context !== undefined && f.context !== null) {
    const normalized = normalizeContext(f.context);
    if (normalized === null) {
      throw new SearchValidationError("context filter is empty or whitespace-only");
    }
    conditions.push("d.context = ?");
    params.push(normalized);
  }

  if (f.source !== undefined && f.source !== null) {
    // Mirror ingest-time treatment: strip but NOT lowercase (unlike context)
    const source = f.source.trim();
    if (!source) {
      throw new SearchValidationError("source filter is empty or whitespace-only");
    }
    conditions.push("d.source = ?");
    params.push(source);
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

  const clause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
  return [clause, params];
}
