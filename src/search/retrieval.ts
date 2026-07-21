/** Document retrieval by UUID or prefix, three formats (DESIGN.md §8.8).
 * Ported from `legacy/python/src/qkb/search/retrieval.py`. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { HydratedResult } from "./hydrate.js";
import { contextDescription, hydrate } from "./hydrate.js";

const LIKE_ESCAPE = "\\";

/** Raised when the id/prefix argument matches no document. Python raises the
 * builtin `KeyError` here; TS has no exact equivalent, so this is a distinct
 * class callers can `instanceof`-check. */
export class DocumentNotFoundError extends Error {}

/** Raised when a prefix matches more than one document. Python raises the
 * builtin `ValueError` here; see `DocumentNotFoundError` for why this is a
 * distinct TS class instead. */
export class AmbiguousDocumentPrefixError extends Error {}

/**
 * Raised when a document's on-disk file is gone or unreadable since the last
 * ingest (moved, deleted, replaced by a directory, permission denied, ...).
 *
 * Python's equivalent subclasses the builtin `FileNotFoundError` so callers
 * that only know about the builtin still catch it. Node has no comparably
 * distinguished builtin hierarchy for filesystem errors (readFileSync throws
 * a plain `Error` with an `.code` like `ENOENT`/`EISDIR` regardless of
 * cause), so this is a plain `Error` subclass — callers match on
 * `instanceof DocumentFileMissing` instead.
 */
export class DocumentFileMissing extends Error {}

/** Escape LIKE metacharacters so `raw` matches only literally, then append
 * the trailing wildcard for prefix matching. Ported from
 * `retrieval.py`'s `_escape_like_prefix`. */
function escapeLikePrefix(raw: string): string {
  const escaped = raw
    .replaceAll(LIKE_ESCAPE, LIKE_ESCAPE + LIKE_ESCAPE)
    .replaceAll("%", `${LIKE_ESCAPE}%`)
    .replaceAll("_", `${LIKE_ESCAPE}_`);
  return `${escaped}%`;
}

/** `hydrate`'s result shape minus the search-only `score`/`matched_text`
 * fields (a single document lookup isn't a ranked search hit), plus the raw
 * markdown text when `includeRaw` is set. */
export type DocumentDetail = Omit<HydratedResult, "score" | "matched_text"> & {
  raw_text?: string;
};

/**
 * Look up a document by exact id or unambiguous id prefix.
 *
 * Throws `DocumentNotFoundError` if no document matches, or
 * `AmbiguousDocumentPrefixError` if more than one does. When `includeRaw` is
 * set, also reads the note's file from `vaultPath` (read-only — never
 * writes) as raw UTF-8 text, prefixed with an HTML comment carrying the
 * context description if one exists; throws `DocumentFileMissing` if that
 * read fails for any reason. Ported from `retrieval.py`'s `get_document`.
 */
export function getDocument(
  conn: Database.Database,
  idOrPrefix: string,
  vaultPath?: string,
  includeRaw = false,
  includeSiblings = true,
): DocumentDetail {
  const rows = conn
    .prepare(`SELECT id FROM documents WHERE id LIKE ? ESCAPE '${LIKE_ESCAPE}'`)
    .all(escapeLikePrefix(idOrPrefix)) as { id: string }[];
  if (rows.length === 0) {
    throw new DocumentNotFoundError(`no document with id (prefix) ${JSON.stringify(idOrPrefix)}`);
  }
  if (rows.length > 1) {
    throw new AmbiguousDocumentPrefixError(
      `ambiguous prefix ${JSON.stringify(idOrPrefix)} matches ${rows.length} documents`,
    );
  }
  const matchedId = (rows[0] as { id: string }).id;
  const hydrated = hydrate(conn, [[matchedId, 0.0, null]])[0];
  if (hydrated === undefined) {
    // Unreachable: `matchedId` was just read from `documents`, so `hydrate`
    // (which batches its own SELECT against the same table) cannot miss it.
    throw new DocumentNotFoundError(`no document with id (prefix) ${JSON.stringify(idOrPrefix)}`);
  }
  // Drop score/matched_text (search-only fields) from the get-by-id shape,
  // mirroring Python's `del doc["score"], doc["matched_text"]`.
  const { score: _score, matched_text: _matchedText, ...rest } = hydrated;
  const doc: DocumentDetail = { ...rest };
  if (!includeSiblings) {
    doc.siblings = [];
  }
  if (includeRaw) {
    if (vaultPath === undefined) {
      throw new Error("include_raw requires vault_path");
    }
    const filePath = join(vaultPath, doc.file_path);
    let text: string;
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new DocumentFileMissing(
          `file moved or deleted since last ingest: ${JSON.stringify(doc.file_path)} ` +
            `(document ${JSON.stringify(doc.document_id)}) — re-run \`qkb ingest\``,
        );
      }
      // Below-the-cut: ENOENT is the common case (moved/deleted since last
      // ingest) and gets the friendly message above. Anything else
      // (EISDIR, EACCES, ...) still means "can't read this document's
      // file" and should surface as the same typed, catchable error rather
      // than a raw exception.
      throw new DocumentFileMissing(
        `cannot read file ${JSON.stringify(doc.file_path)} (document ${JSON.stringify(doc.document_id)}): ${err.message}`,
      );
    }
    const desc = contextDescription(conn, doc.context);
    doc.raw_text = desc ? `<!-- Context: ${desc} -->\n\n${text}` : text;
  }
  return doc;
}
