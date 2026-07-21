/** Shared cross-module types (plan §4 `src/types.ts`). Ported from `qkb.models`. */

/** A frontmatter-derived, indexable note. Field names are camelCase here (TS
 * convention throughout this codebase); the underlying columns in
 * `src/db/schema.ts` keep the original snake_case from `db.py`. */
export interface ParsedNote {
  id: string;
  type: string;
  title: string;
  context: string | null;
  source: string | null;
  effectiveDate: string; // YYYY-MM-DD
  createdAt: string; // full ISO 8601
  tags: string[];
  extraMetadata: Record<string, string>;
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
}

/** A structurally-scored slice of a note's body, ready for embedding.
 * Ported from `qkb.models.Chunk` (`legacy/python/src/qkb/models.py`). Python's
 * Chunk carries only these three fields — chunk storage there is keyed by
 * `document_id` (see `legacy/python/src/qkb/ingest/storage.py`), not by a
 * per-chunk `source`, so none is added here (parity with the authoritative
 * Python spec over the plan's illustrative field list). */
export interface Chunk {
  index: number;
  text: string;
  tokenCount: number;
}

// Reserved frontmatter key for the Storage layer's metadata-change hash row
// (`src/db/storage.ts`, Task 7 — not yet ported). Defined here rather than in
// storage.ts (which doesn't exist yet) so `src/ingest/parser.ts` can strip it
// without a forward reference; storage.ts will import it from here when it
// lands. Ported verbatim from `storage.py` `_METADATA_HASH_KEY`: a note
// carrying this key in frontmatter would collide on the metadata
// (document_id, key) PK at write time, so the parser strips it defensively.
export const RESERVED_METADATA_KEY = "__qkb_meta_hash__";
