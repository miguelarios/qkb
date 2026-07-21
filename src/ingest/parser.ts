/** Frontmatter -> ParsedNote. Lenient about real-world vault data (DESIGN.md §4-5).
 * Ported from `legacy/python/src/qkb/ingest/parser.py`. */

import { readFileSync } from "node:fs";
import { basename, extname, relative, sep } from "node:path";
import matter from "gray-matter";
import * as yaml from "js-yaml";
import { type ParsedNote, RESERVED_METADATA_KEY } from "../types.js";

/**
 * An opted-in note (has `context` or `source`) cannot be indexed because of
 * a data error - a missing `id`, or no parseable date.
 *
 * Thrown instead of returning null so the ingest pipeline's catch-all branch
 * treats it like any other transient parse failure: the note is logged,
 * counted as `skipped`, and (if it was previously indexed) protected from the
 * deletion sweep via its stored file_path. A null return is reserved for a
 * TRUE opt-out (no context AND no source), which is a legitimate de-index.
 */
export class NoteDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteDataError";
  }
}

// Ports Python 3.11+ `datetime.fromisoformat`'s acceptance surface. That
// grammar is too context-sensitive for one regex (the time and offset
// sub-parts must each be *internally* consistent about using ":" or not,
// independently of each other, and a trailing fraction always means
// fractional *seconds* regardless of which clock field precedes it) so it's
// parsed in stages: date prefix -> single-char separator -> time -> offset.
// Week-date forms (YYYY-Www[-D]), which fromisoformat also accepts, are
// deliberately not implemented - vanishingly unlikely in vault frontmatter
// and not worth the added ISO-week-to-Gregorian conversion risk.

/** Matches the date prefix: extended `YYYY-MM-DD` or basic `YYYYMMDD`. Returns
 * the raw digit captures (so leading zeros survive) and how many characters
 * of the input the date consumed. */
function matchDatePrefix(
  v: string,
): { y: string; mo: string; d: string; restIndex: number } | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return { y: m[1] ?? "", mo: m[2] ?? "", d: m[3] ?? "", restIndex: m[0].length };
  m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  if (m) return { y: m[1] ?? "", mo: m[2] ?? "", d: m[3] ?? "", restIndex: m[0].length };
  return null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  // Day 0 of "next month" (JS Date month index == our 1-based month) is the
  // last day of the target month - a clean way to get days-in-month without
  // a lookup table (handles leap years for free).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** Splits a trailing `.digits` or `,digits` fraction off the end of a clock
 * value. fromisoformat treats this fraction as fractional *seconds* no
 * matter which field (hour/minute/second) it's attached to. */
function splitFraction(s: string): { core: string; frac: string | null } {
  const m = /^(.*)[.,](\d+)$/.exec(s);
  return m ? { core: m[1] ?? "", frac: m[2] ?? "" } : { core: s, frac: null };
}

interface ClockUnits {
  hh: number;
  mm: number | null;
  ss: number | null;
}

/** Parses `HH[:MM[:SS]]` (or the basic `HH[MM[SS]]` form), requiring the
 * ":" usage to be consistent between the two boundaries when both are
 * present. Returns the raw units with no range validation. */
function parseClockValue(s: string): ClockUnits | null {
  const m = /^(\d{2})(?:(:?)(\d{2})(?:(:?)(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, hh, colon1, mm, colon2, ss] = m;
  if (mm !== undefined && ss !== undefined && colon1 !== colon2) return null;
  return {
    hh: Number(hh),
    mm: mm !== undefined ? Number(mm) : null,
    ss: ss !== undefined ? Number(ss) : null,
  };
}

function validateTimePart(s: string): boolean {
  if (s.length === 0) return false;
  const { core } = splitFraction(s);
  const units = parseClockValue(core);
  if (!units) return false;
  const { hh, mm, ss } = units;
  if (hh < 0 || hh > 23) return false;
  if (mm !== null && (mm < 0 || mm > 59)) return false;
  if (ss !== null && (ss < 0 || ss > 59)) return false;
  return true;
}

/** Validates a UTC offset ("Z" or `[+-]HH[:MM[:SS]]`, optionally with a
 * fraction). Python does not range-check the individual offset fields
 * (empirically, `+00:60` is accepted and normalized) - only that the total
 * magnitude stays strictly under 24h. */
function validateOffsetPart(s: string): boolean {
  if (s === "Z") return true;
  const sign = s[0];
  if (sign !== "+" && sign !== "-") return false;
  const body = s.slice(1);
  if (body.length === 0) return false;
  const { core, frac } = splitFraction(body);
  const units = parseClockValue(core);
  if (!units) return false;
  const { hh, mm, ss } = units;
  const fracSeconds = frac ? Number(`0.${frac}`) : 0;
  const totalSeconds = hh * 3600 + (mm ?? 0) * 60 + (ss ?? 0) + fracSeconds;
  return totalSeconds < 24 * 3600;
}

function validateTimeAndOffset(rest: string): boolean {
  if (rest.length === 0) return true; // date-only
  if (rest.length < 2) return false; // lone separator, nothing after it
  const afterSep = rest.slice(1); // separator itself: any single character
  const offsetIdx = afterSep.search(/[Z+-]/);
  const timePart = offsetIdx === -1 ? afterSep : afterSep.slice(0, offsetIdx);
  const offsetPart = offsetIdx === -1 ? null : afterSep.slice(offsetIdx);
  if (!validateTimePart(timePart)) return false;
  if (offsetPart !== null && !validateOffsetPart(offsetPart)) return false;
  return true;
}

export function parseDateLenient(value: unknown): string | null {
  if (value instanceof Date) {
    // Defensive: the yaml engine below (CORE_SCHEMA) never produces Date
    // instances - it keeps date-like scalars as strings, mirroring how
    // parser.py reads the *raw* alias value for created_at. Kept for parity
    // with parser.py's `isinstance(value, dt.date)` branches in case a
    // caller ever passes a native Date some other way.
    const y = value.getUTCFullYear();
    const mo = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  if (typeof value === "string") {
    const v = value.trim();
    if (!v || v.startsWith("<%")) return null;
    const dateMatch = matchDatePrefix(v);
    if (!dateMatch) return null;
    const { y, mo, d, restIndex } = dateMatch;
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    if (!validateTimeAndOffset(v.slice(restIndex))) return null;
    return `${y}-${mo}-${d}`;
  }
  return null;
}

// Mirrors PyYAML's SafeLoader implicit timestamp resolver, which is what
// `frontmatter.load()` (parser.py's `frontmatter.load`) uses. A `created`
// value shaped like this is auto-parsed by PyYAML into a `datetime`, and
// Python's `.isoformat()` always renders the date/time separator as "T" -
// even when the frontmatter author wrote a space. This is a *narrower*
// grammar than fromisoformat above (month/day may be 1-2 digits but MM:SS
// are both mandatory, no basic/no-dash date, no bare-Z-less hour-only time),
// so it's kept separate rather than reusing matchDatePrefix/validateTimeAndOffset.
const YAML_TIMESTAMP_RE =
  /^(\d{4}-\d{1,2}-\d{1,2})([Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[+-]\d{1,2}(?::\d{2})?))?$/;

/** Canonicalizes a raw `created`/`date` frontmatter string the way Python's
 * `datetime.isoformat()` would, IF (and only if) PyYAML would have auto-
 * parsed it into a `datetime` in the first place (see YAML_TIMESTAMP_RE).
 * Only the separator changes - offset, fraction, and digit widths are left
 * exactly as written, matching the "keep the raw string" philosophy CORE_SCHEMA
 * already commits to for this value.
 *
 * Known narrow gap (intentionally out of scope): PyYAML's resolver allows a
 * 1-2 digit month/day/hour here, and real Python's `.isoformat()` would
 * zero-pad those too. A value shaped that way never reaches this function in
 * the TS port anyway - `parseDateLenient`'s fromisoformat-parity date prefix
 * requires 2-digit month/day, so such a `created` value fails to parse
 * upstream (throwing NoteDataError, absent a valid `date` alias) before
 * canonicalization would matter. Real Python avoids this because PyYAML
 * already parsed and validated the value before `parse_date_lenient` ever
 * sees it. Reconciling that would mean re-adding a YAML-timestamp-shaped
 * acceptance path to parseDateLenient - which is exactly the complexity
 * CORE_SCHEMA's "keep it a raw string" decision was meant to avoid. */
function canonicalizeCreatedAt(raw: string): string {
  const m = YAML_TIMESTAMP_RE.exec(raw);
  if (!m) return raw;
  const datePart = m[1] ?? "";
  const sep = m[2] ?? "";
  if (sep === "T") return raw;
  return `${datePart}T${raw.slice(datePart.length + sep.length)}`;
}

export function normalizeContext(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  return v || null;
}

function get(meta: Record<string, unknown>, aliases: string[]): unknown {
  for (const key of aliases) {
    if (key in meta) {
      const v = meta[key];
      if (v !== null && v !== "") return v;
    }
  }
  return null;
}

/**
 * Walk an alias list and return the (raw, parsed) pair for the first alias
 * whose value is present, non-empty, AND satisfies `parse`.
 *
 * Unlike `get`, a present-but-unparseable value does not stop the search:
 * per DESIGN.md §5, invalid values fall through to the next alias.
 */
function getParsed<T>(
  meta: Record<string, unknown>,
  aliases: string[],
  parse: (value: unknown) => T | null,
): [unknown, T] | null {
  for (const key of aliases) {
    if (key in meta) {
      const v = meta[key];
      if (v !== null && v !== "") {
        const parsed = parse(v);
        if (parsed !== null) return [v, parsed];
      }
    }
  }
  return null;
}

function stringify(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(", ");
  }
  return String(value);
}

/** Required frontmatter alias-map keys (mirrors `qkb.config.DEFAULT_FRONTMATTER`). */
function aliasesFor(fmMap: Record<string, string[]>, key: string): string[] {
  const v = fmMap[key];
  if (v === undefined) {
    throw new Error(`frontmatter alias map is missing required key "${key}"`);
  }
  return v;
}

export function parseNote(
  path: string,
  vaultRoot: string,
  fmMap: Record<string, string[]>,
): ParsedNote | null {
  // gray-matter's default (js-yaml DEFAULT_SCHEMA) auto-parses YAML 1.1
  // timestamps into JS Date objects - which, unlike Python's tz-aware
  // datetime, cannot round-trip the original UTC offset (toISOString always
  // emits "Z"). CORE_SCHEMA drops the timestamp type so date-like scalars
  // stay strings, letting us read the raw alias value for created_at exactly
  // like parser.py does via PyYAML's isoformat()-preserving datetime.
  const raw = readFileSync(path, "utf-8");
  const post = matter(raw, {
    engines: {
      yaml: (s: string) => yaml.load(s, { schema: yaml.CORE_SCHEMA }) as object,
    },
  });
  const meta = post.data as Record<string, unknown>;

  const context = normalizeContext(get(meta, aliasesFor(fmMap, "context")));
  const sourceRaw = get(meta, aliasesFor(fmMap, "source"));
  const source = sourceRaw !== null && String(sourceRaw).trim() ? String(sourceRaw).trim() : null;
  if (context === null && source === null) {
    return null; // true opt-out (no context AND no source): a legitimate de-index
  }

  // From here the note is OPTED IN. If it's unindexable due to a data error
  // (missing id, or no parseable date) we THROW rather than return null, so
  // the pipeline protects a previously-indexed entry instead of de-indexing
  // it on a transient/graceful failure. Only a true opt-out returns null.
  const noteId = get(meta, aliasesFor(fmMap, "id"));
  if (noteId === null) {
    throw new NoteDataError(`${path}: opted-in note has no id`);
  }

  const createdHit = getParsed(meta, aliasesFor(fmMap, "created"), parseDateLenient);
  const dateHit = getParsed(meta, aliasesFor(fmMap, "date"), parseDateLenient);
  const effective = dateHit?.[1] ?? createdHit?.[1] ?? null;
  if (effective === null) {
    throw new NoteDataError(`${path}: opted-in note has no parseable date`);
  }
  const createdAt = createdHit === null ? effective : canonicalizeCreatedAt(String(createdHit[0]));

  const tagsRaw = get(meta, aliasesFor(fmMap, "tags"));
  let tags: string[];
  if (typeof tagsRaw === "string") {
    tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  } else if (Array.isArray(tagsRaw)) {
    tags = tagsRaw.map((t) => String(t).trim()).filter((t) => t.length > 0);
  } else {
    tags = [];
  }

  const consumed = new Set(Object.values(fmMap).flat());
  if (RESERVED_METADATA_KEY in meta) {
    // This key is reserved by Storage for its metadata-change hash row. A
    // note carrying it in frontmatter would collide on the metadata
    // (document_id, key) PK at write time; strip it here so the storage
    // layer's own filter is never even exercised.
    console.warn(`${path}: dropping reserved frontmatter key "${RESERVED_METADATA_KEY}"`);
  }
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (consumed.has(k) || k === RESERVED_METADATA_KEY) continue;
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
      continue;
    }
    extra[k] = stringify(v);
  }

  const titleRaw = get(meta, aliasesFor(fmMap, "title"));
  const typeRaw = get(meta, aliasesFor(fmMap, "type"));
  const filePath = relative(vaultRoot, path).split(sep).join("/");

  return {
    id: String(noteId),
    type: typeRaw ? String(typeRaw) : "note",
    title: titleRaw ? String(titleRaw) : basename(path, extname(path)),
    context,
    source,
    effectiveDate: effective,
    createdAt,
    tags,
    extraMetadata: extra,
    body: post.content,
    filePath,
  };
}
