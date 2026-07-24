/** SQLite write operations. Each public method is one transaction.
 *
 * Ported from `legacy/python/src/qkb/ingest/storage.py` — same SQL, same
 * transaction boundaries, same hash algorithms (byte-compatible: same
 * content produces the same hash in both implementations). See that file's
 * docstrings for the "why" behind the sentinel-row mechanics; comments here
 * only note where the TS port diverges mechanically (BigInt binds, etc).
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Chunk, ParsedNote } from "../types.js";
import { RESERVED_METADATA_KEY } from "../types.js";
import { placeholders, rebuildVectorTable, vectorTableDimension } from "./schema.js";

export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

// Reserved key in the `metadata` KV table used to stash a hash of the
// frontmatter-derived fields for a document — see `metadataHash` below.
// Ported verbatim from storage.py's `_METADATA_HASH_KEY` (defined there as a
// module constant; here it's `RESERVED_METADATA_KEY` from `src/types.ts` so
// `src/ingest/parser.ts` can strip it without importing this module).
const _METADATA_HASH_KEY = RESERVED_METADATA_KEY;

// Sentinel key in the same `embedding_config` KV table marking "a --full
// re-embed is currently in progress / did not complete". See
// `markIngestInProgress`/`clearIngestInProgress`/`isIngestInProgress` below.
const _INGEST_IN_PROGRESS_KEY = "ingest_in_progress";

// Delimiters for metadata_hash serialization. Distinct ASCII control
// characters at each nesting level so no field/list/pair boundary is
// ambiguous (e.g. tags ["a,b"] and ["a","b"] must not collide). US = field
// separator, RS = list-item separator, GS = key/value separator.
const _FIELD_SEP = "\x1f";
const _ITEM_SEP = "\x1e";
const _KV_SEP = "\x1d";

function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable hash over every non-body column `updateMetadataIfChanged` is
 * responsible for keeping in sync when the body is unchanged: title, type,
 * context, source, effectiveDate, createdAt, tags, extraMetadata, AND
 * filePath + vaultName. See storage.py's `metadata_hash` docstring for why
 * filePath/vaultName are folded in (rename detection) and body is excluded
 * (covered by `contentHash`). */
export function metadataHash(note: ParsedNote, vaultName = "Notes"): string {
  const parts = [
    note.title || "",
    note.type,
    note.context ?? "",
    note.source ?? "",
    note.effectiveDate,
    note.createdAt,
    note.filePath,
    vaultName,
    [...note.tags].sort(codepointCompare).join(_ITEM_SEP),
    Object.entries(note.extraMetadata)
      .sort(([a], [b]) => codepointCompare(a, b))
      .map(([k, v]) => `${k}${_KV_SEP}${v}`)
      .join(_ITEM_SEP),
  ];
  return createHash("sha256").update(parts.join(_FIELD_SEP), "utf-8").digest("hex");
}

export interface ContextRow {
  context: string;
  count: number;
  description: string | null;
}

export interface Stats {
  documents: number;
  chunks: number;
  vectors: number | null;
  dim: number | null;
  contexts: ContextRow[];
  lastIndexedAt: string | null;
}

// Distinguishes "caller did not pass storedMetadataHash" (fall back to the
// per-doc SELECT) from "caller passed a batched value, which may legitimately
// be null" in updateMetadataIfChanged — mirrors storage.py's `_NOT_GIVEN`.
const _NOT_GIVEN: unique symbol = Symbol("NOT_GIVEN");

export class Storage {
  private readonly conn: Database.Database;
  private readonly vaultName: string;

  constructor(conn: Database.Database, vaultName = "Notes") {
    this.conn = conn;
    this.vaultName = vaultName;
  }

  getContentHash(docId: string): string | null {
    const row = this.conn.prepare("SELECT content_hash FROM documents WHERE id = ?").get(docId) as
      | { content_hash: string }
      | undefined;
    return row ? row.content_hash : null;
  }

  getMetadataHash(docId: string): string | null {
    const row = this.conn
      .prepare("SELECT value FROM metadata WHERE document_id = ? AND key = ?")
      .get(docId, _METADATA_HASH_KEY) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Map of document_id -> stored metadata_hash for every indexed document.
   * Batches the per-unchanged-doc point SELECT `updateMetadataIfChanged`
   * would otherwise run once per document — mirrors `indexedPaths()`. */
  allMetadataHashes(): Record<string, string> {
    const rows = this.conn
      .prepare("SELECT document_id, value FROM metadata WHERE key = ?")
      .all(_METADATA_HASH_KEY) as { document_id: string; value: string }[];
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.document_id] = r.value;
    }
    return result;
  }

  /** Map of vault-relative file_path -> document id for indexed documents. */
  indexedPaths(): Record<string, string> {
    const rows = this.conn.prepare("SELECT id, file_path FROM documents").all() as {
      id: string;
      file_path: string;
    }[];
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.file_path] = r.id;
    }
    return result;
  }

  private writeDocRow(note: ParsedNote, chash: string): void {
    this.conn
      .prepare(
        `INSERT INTO documents
           (id, type, context, source, effective_date, created_at,
            file_path, content_hash, title, vault_name)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             type=excluded.type, context=excluded.context, source=excluded.source,
             effective_date=excluded.effective_date, created_at=excluded.created_at,
             file_path=excluded.file_path, content_hash=excluded.content_hash,
             title=excluded.title, vault_name=excluded.vault_name,
             indexed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      )
      .run(
        note.id,
        note.type,
        note.context,
        note.source,
        note.effectiveDate,
        note.createdAt,
        note.filePath,
        chash,
        note.title,
        this.vaultName,
      );
  }

  private writeFtsRow(note: ParsedNote): void {
    this.conn.prepare("DELETE FROM documents_fts WHERE doc_id = ?").run(note.id);
    this.conn
      .prepare(
        "INSERT INTO documents_fts (title, tags, context, body, type, doc_id) VALUES (?,?,?,?,?,?)",
      )
      .run(note.title, note.tags.join(" "), note.context ?? "", note.body, note.type, note.id);
  }

  private writeTagsAndMetadata(note: ParsedNote, mhash: string): void {
    this.conn.prepare("DELETE FROM tags WHERE document_id = ?").run(note.id);
    const insertTag = this.conn.prepare("INSERT INTO tags (document_id, tag) VALUES (?,?)");
    for (const t of new Set(note.tags)) {
      insertTag.run(note.id, t);
    }
    this.conn.prepare("DELETE FROM metadata WHERE document_id = ?").run(note.id);
    // Drop any user frontmatter key colliding with our reserved hash key —
    // see storage.py's `_write_tags_and_metadata` for why (PK collision would
    // abort the whole ingest run). The parser also strips it defensively;
    // this is the belt-and-suspenders half.
    const insertMeta = this.conn.prepare(
      "INSERT INTO metadata (document_id, key, value) VALUES (?,?,?)",
    );
    for (const [k, v] of Object.entries(note.extraMetadata)) {
      if (k !== _METADATA_HASH_KEY) {
        insertMeta.run(note.id, k, v);
      }
    }
    insertMeta.run(note.id, _METADATA_HASH_KEY, mhash);
  }

  /** Write the document, FTS row, tags/metadata, and chunks in one
   * transaction. When `embeddings` is omitted/null the chunks are stored
   * WITHOUT vectors — the structural-only `qkb ingest` pass, so keyword/BM25
   * search works immediately and `qkb embed` fills vectors in later. When
   * given, vectors are written inline (one per chunk). */
  upsert(note: ParsedNote, chash: string, chunks: Chunk[], embeddings?: number[][] | null): void {
    const vecs: (number[] | null)[] = embeddings != null ? [...embeddings] : chunks.map(() => null);
    if (vecs.length !== chunks.length) {
      throw new Error(
        `upsert: chunks (${chunks.length}) and embeddings (${vecs.length}) length mismatch`,
      );
    }
    const tx = this.conn.transaction(() => {
      this.deleteChunks(note.id);
      this.writeDocRow(note, chash);
      this.writeFtsRow(note);
      this.writeTagsAndMetadata(note, metadataHash(note, this.vaultName));
      const insertChunk = this.conn.prepare(
        "INSERT INTO chunks (document_id, chunk_index, chunk_text, token_count) VALUES (?,?,?,?)",
      );
      const insertVec = this.conn.prepare(
        "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?,?)",
      );
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] as Chunk;
        const vec = vecs[i] as number[] | null;
        const cur = insertChunk.run(note.id, chunk.index, chunk.text, chunk.tokenCount);
        if (vec !== null) {
          // CRITICAL: chunk_id must bind as BigInt — chunks_vec is a vec0
          // virtual table's INTEGER PRIMARY KEY, which rejects a plain
          // number bind (better-sqlite3 binds it as REAL). See
          // src/db/schema.ts connect() docstring.
          insertVec.run(BigInt(cur.lastInsertRowid as number), new Float32Array(vec));
        }
      }
    });
    tx();
  }

  /** (chunk_id, chunk_text) for chunks that don't have a vector yet — the
   * work queue for `qkb embed`. */
  pendingChunks(): [number, string][] {
    const rows = this.conn
      .prepare(
        "SELECT id, chunk_text FROM chunks " +
          "WHERE id NOT IN (SELECT chunk_id FROM chunks_vec) ORDER BY id",
      )
      .all() as { id: number; chunk_text: string }[];
    return rows.map((r) => [r.id, r.chunk_text]);
  }

  /** Insert embeddings for the given chunk ids in one transaction. Each call
   * commits, so an interrupted `qkb embed` keeps the vectors it already
   * wrote and a re-run resumes from `pendingChunks()`. */
  writeVectors(rows: [number, number[]][]): void {
    if (rows.length === 0) {
      return;
    }
    const insertVec = this.conn.prepare(
      "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?,?)",
    );
    const tx = this.conn.transaction(() => {
      for (const [cid, vec] of rows) {
        insertVec.run(BigInt(cid), new Float32Array(vec));
      }
    });
    tx();
  }

  /** Refresh the documents row, FTS metadata columns, tags, and metadata for
   * a document whose body is known unchanged (caller already matched
   * `contentHash`) — but ONLY if the frontmatter-derived metadata actually
   * changed since the last ingest.
   *
   * `storedMetadataHash`, if given, is the caller's already-fetched value
   * (e.g. from `allMetadataHashes()`), so this method skips its own per-doc
   * `getMetadataHash` SELECT. Omit it (the default) to fall back to the old
   * per-doc SELECT.
   *
   * Returns true if a write happened (indexed_at legitimately advances),
   * false if this was a true no-op: no transaction opened, nothing written,
   * indexed_at untouched. */
  updateMetadataIfChanged(
    note: ParsedNote,
    chash: string,
    storedMetadataHash: string | null | typeof _NOT_GIVEN = _NOT_GIVEN,
  ): boolean {
    const mhash = metadataHash(note, this.vaultName);
    const stored =
      storedMetadataHash === _NOT_GIVEN ? this.getMetadataHash(note.id) : storedMetadataHash;
    if (stored === mhash) {
      return false;
    }
    const tx = this.conn.transaction(() => {
      this.writeDocRow(note, chash);
      this.writeFtsRow(note);
      this.writeTagsAndMetadata(note, mhash);
    });
    tx();
    return true;
  }

  private deleteChunks(docId: string): void {
    const ids = (
      this.conn.prepare("SELECT id FROM chunks WHERE document_id = ?").all(docId) as {
        id: number;
      }[]
    ).map((r) => r.id);
    if (ids.length > 0) {
      const marks = placeholders(ids.length);
      // BigInt binds — see the note in upsert() above.
      this.conn
        .prepare(`DELETE FROM chunks_vec WHERE chunk_id IN (${marks})`)
        .run(...ids.map((id) => BigInt(id)));
      this.conn.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
    }
  }

  /** Blank out `documents.content_hash` for `docId`. Empty string satisfies
   * the NOT NULL column and can never equal a real 64-hex-char sha256 hash,
   * so the next successful parse of this doc is guaranteed to miss the
   * hash-unchanged fast path and go through the full chunk/embed/upsert
   * path instead. */
  clearContentHash(docId: string): void {
    const tx = this.conn.transaction(() => {
      this.conn.prepare("UPDATE documents SET content_hash = '' WHERE id = ?").run(docId);
    });
    tx();
  }

  delete(docId: string): void {
    const tx = this.conn.transaction(() => {
      this.deleteChunks(docId);
      this.conn.prepare("DELETE FROM documents_fts WHERE doc_id = ?").run(docId);
      this.conn.prepare("DELETE FROM documents WHERE id = ?").run(docId);
    });
    tx();
  }

  /** (model_name, dim) the existing index was embedded with, or null if no
   * embedding config has been committed yet (fresh DB). Read-only — used by
   * `qkb status` to surface config-vs-index model mismatches. */
  storedEmbeddingConfig(): [string, number] | null {
    const rows = this.conn.prepare("SELECT * FROM embedding_config").all() as {
      key: string;
      value: string;
    }[];
    const map: Record<string, string> = {};
    for (const r of rows) {
      map[r.key] = r.value;
    }
    if (!("model_name" in map)) {
      return null;
    }
    return [map.model_name as string, Number(map.embedding_dim)];
  }

  checkEmbeddingConfig(modelName: string, dim: number): boolean {
    const rows = this.conn.prepare("SELECT * FROM embedding_config").all() as {
      key: string;
      value: string;
    }[];
    if (rows.length === 0) {
      // Nothing committed yet (fresh DB) — this is the first-ever ingest for
      // this index, so there is no prior model to mix vectors with.
      this.commitEmbeddingConfig(modelName, dim);
      return true;
    }
    const map: Record<string, string> = {};
    for (const r of rows) {
      map[r.key] = r.value;
    }
    return map.model_name === modelName && map.embedding_dim === String(dim);
  }

  /** Record model_name/dim as the current, committed embedding config.
   * Overwrites any prior rows (including the ingest-in-progress sentinel —
   * see `clearIngestInProgress`). Callers driving a `--full` re-embed must
   * only call this once re-embedding has completed successfully. */
  commitEmbeddingConfig(modelName: string, dim: number): void {
    const tx = this.conn.transaction(() => {
      this.conn.prepare("DELETE FROM embedding_config").run();
      const insert = this.conn.prepare("INSERT INTO embedding_config (key, value) VALUES (?,?)");
      insert.run("model_name", modelName);
      insert.run("embedding_dim", String(dim));
    });
    tx();
  }

  /** Drop and recreate the chunks_vec vector index at `embeddingDim`. Used at
   * the start of a `--full` re-embed so a model/dimension change doesn't
   * crash on the first insert at the new dimension. */
  rebuildVectorIndex(embeddingDim: number): void {
    rebuildVectorTable(this.conn, embeddingDim);
  }

  /** Set the `ingest_in_progress` sentinel in `embedding_config`. Called at
   * the START of a `--full` re-embed so an interruption partway through is
   * detectable on the next plain ingest. */
  markIngestInProgress(): void {
    const tx = this.conn.transaction(() => {
      this.conn
        .prepare(
          "INSERT INTO embedding_config (key, value) VALUES (?, '1') " +
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(_INGEST_IN_PROGRESS_KEY);
    });
    tx();
  }

  /** Clear the `ingest_in_progress` sentinel. Called at the very end of a
   * `--full` re-embed, right after `commitEmbeddingConfig`. */
  clearIngestInProgress(): void {
    const tx = this.conn.transaction(() => {
      this.conn.prepare("DELETE FROM embedding_config WHERE key = ?").run(_INGEST_IN_PROGRESS_KEY);
    });
    tx();
  }

  isIngestInProgress(): boolean {
    const row = this.conn
      .prepare("SELECT value FROM embedding_config WHERE key = ?")
      .get(_INGEST_IN_PROGRESS_KEY) as { value: string } | undefined;
    return row !== undefined && row.value === "1";
  }

  /** Store/clear a context's description, keyed by its NORMALIZED label.
   * Normalizes `context` here rather than trusting the caller to have
   * already done it — mirrors `normalize_context`'s
   * `str(value).strip().lower() or None` exactly. */
  setContextDescription(context: string, description: string | null): void {
    const trimmed = String(context).trim().toLowerCase();
    const normalized = trimmed === "" ? null : trimmed;
    if (normalized === null) {
      throw new Error("context must not be empty");
    }
    const tx = this.conn.transaction(() => {
      if (description === null) {
        this.conn.prepare("DELETE FROM context_descriptions WHERE context = ?").run(normalized);
      } else {
        this.conn
          .prepare(
            "INSERT INTO context_descriptions (context, description) VALUES (?,?) " +
              "ON CONFLICT(context) DO UPDATE SET description=excluded.description",
          )
          .run(normalized, description);
      }
    });
    tx();
  }

  listContexts(): ContextRow[] {
    return this.conn
      .prepare(
        `SELECT d.context AS context, COUNT(*) AS count, cd.description AS description
           FROM documents d
           LEFT JOIN context_descriptions cd ON cd.context = d.context
           WHERE d.context IS NOT NULL
           GROUP BY d.context ORDER BY count DESC, d.context`,
      )
      .all() as ContextRow[];
  }

  /** Cheap existence check for a single context name — an indexed point
   * lookup (`idx_documents_context`) rather than `listContexts`' full
   * `GROUP BY` aggregation over every document. Used by the CLI's
   * search-time "is this query exactly a context name?" tip (issue #14),
   * which runs on every human-output search and only needs a yes/no. */
  hasContext(context: string): boolean {
    return (
      this.conn.prepare("SELECT 1 FROM documents WHERE context = ? LIMIT 1").get(context) !==
      undefined
    );
  }

  stats(): Stats {
    const documents = (
      this.conn.prepare("SELECT COUNT(*) c FROM documents").get() as {
        c: number;
      }
    ).c;
    const chunks = (this.conn.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    let vectors: number | null;
    try {
      vectors = (this.conn.prepare("SELECT COUNT(*) c FROM chunks_vec").get() as { c: number }).c;
    } catch {
      vectors = null;
    }
    const last = this.conn.prepare("SELECT MAX(indexed_at) m FROM documents").get() as {
      m: string | null;
    };
    return {
      documents,
      chunks,
      vectors,
      dim: vectorTableDimension(this.conn),
      contexts: this.listContexts(),
      lastIndexedAt: last.m,
    };
  }
}
