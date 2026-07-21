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

// Matches Python 3.11+ `datetime.fromisoformat`: date, optionally followed by
// any single separator char, then HH:MM with optional :SS, optional
// fractional seconds, and an optional "Z" or +/-HH:MM(:not required) offset.
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:.(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of "next month" (JS Date month index == our 1-based month) is the
  // last day of the target month - a clean way to get days-in-month without
  // a lookup table (handles leap years for free).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
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
    const m = ISO_DATE_RE.exec(v);
    if (!m) return null;
    const [, y, mo, d] = m;
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    return `${y}-${mo}-${d}`;
  }
  return null;
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
  const createdAt = createdHit === null ? effective : String(createdHit[0]);

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
