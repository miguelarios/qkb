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

// Reserved frontmatter key for the Storage layer's metadata-change hash row
// (`src/db/storage.ts`, Task 7 — not yet ported). Defined here rather than in
// storage.ts (which doesn't exist yet) so `src/ingest/parser.ts` can strip it
// without a forward reference; storage.ts will import it from here when it
// lands. Ported verbatim from `storage.py` `_METADATA_HASH_KEY`: a note
// carrying this key in frontmatter would collide on the metadata
// (document_id, key) PK at write time, so the parser strips it defensively.
export const RESERVED_METADATA_KEY = "__qkb_meta_hash__";
