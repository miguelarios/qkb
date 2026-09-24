/** Shared cross-module types (plan §4 `src/types.ts`). Ported from `qkb.models`. */

/** A frontmatter-derived, indexable note. Field names are camelCase here (TS
 * convention throughout this codebase); the underlying columns in
 * `src/db/schema.ts` keep the original snake_case from `db.py`. */
export interface ParsedNote {
  id: string;
  type: string;
  title: string;
  effectiveDate: string; // YYYY-MM-DD
  createdAt: string; // full ISO 8601
  tags: string[];
  /** Obsidian `aliases`: alternative titles, ranked like the title (#34). */
  aliases?: string[];
  /** Text of the body's headings, outside code blocks (#34). */
  headings?: string[];
  /** Targets of the body's `[[wikilinks]]` (#36). */
  links?: string[];
  extraMetadata: Record<string, string>;
  /** Declared extra properties (`[frontmatter.fields]`) present on this
   * note, in declaration order — a subset of `extraMetadata`. Searchable,
   * embedded, and returned in results. */
  fields?: Record<string, string>;
  /** Which of `fields` are sibling fields (`siblings = true` in config). */
  siblingKeys?: string[];
  body: string;
  filePath: string; // vault-relative, POSIX separators
}

/** Per-run ingestion tally returned by `ingestVault` (and, later, the embed
 * pass). Ported verbatim from `qkb.models.IngestStats` — same six counters,
 * same zero defaults. `scanned` counts every *.md file the vault walk visited
 * this run; the rest partition what happened to each (indexed = newly added,
 * updated = body changed, unchanged = body+metadata identical, deindexed =
 * removed by the deletion sweep, skipped = opt-out/parse-failure/duplicate). */
export interface IngestStats {
  scanned: number;
  indexed: number;
  updated: number;
  unchanged: number;
  deindexed: number;
  skipped: number;
  /** Notes skipped because they have no `id` (part of `skipped`). */
  withoutId?: number;
}

/** A structurally-scored slice of a note's body, ready for embedding.
 * Ported from `qkb.models.Chunk` (`legacy/python/src/qkb/models.py`). Python's
 * Chunk carries only these three fields — chunk storage there is keyed by
 * `document_id` (see `legacy/python/src/qkb/ingest/storage.py`), not by a
 * per-chunk `source`, so none is added here (parity with the authoritative
 * Python spec over the plan's illustrative field list). */
/** Render declared fields as the `key: value` lines that are indexed in the
 * FTS `fields` column and prepended to every chunk's embedded text. */
export function renderFields(fields: Record<string, string>): string {
  // One line per field: newlines inside a value are flattened so the text
  // parses back unambiguously (see hydrate's `parseFieldsText`).
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v.replace(/\s*\n\s*/g, " ").trim()}`)
    .join("\n");
}

/** The text actually embedded for a chunk: the note's rendered fields (if
 * any) as a header, then the chunk text. Shared by the inline-embed ingest
 * path and `embedPending` so both produce identical vectors. */
export function embeddingText(fieldsText: string, chunkText: string): string {
  return fieldsText ? `${fieldsText}\n\n${chunkText}` : chunkText;
}

export interface Chunk {
  index: number;
  text: string;
  tokenCount: number;
}

// Reserved frontmatter key for the Storage layer's metadata-change hash row
// (`src/db/storage.ts`). Lives here, not in storage.ts, so both
// `src/ingest/parser.ts` and storage.ts can import it without depending on
// each other. Ported verbatim from `storage.py` `_METADATA_HASH_KEY`: a note
// carrying this key in frontmatter would collide on the metadata
// (document_id, key) PK at write time, so the parser strips it defensively.
export const RESERVED_METADATA_KEY = "__qkb_meta_hash__";
