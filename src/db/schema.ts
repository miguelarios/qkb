/** SQLite connection + schema. Single source of DDL truth (DESIGN.md §6). */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// Ported verbatim from legacy/python/src/qkb/db.py `_SCHEMA` — same names,
// same columns, same tokenizer. Golden-query tuning depends on this being an
// exact port, not a reinterpretation.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
    id             TEXT PRIMARY KEY,
    type           TEXT NOT NULL,
    context        TEXT,
    source         TEXT,
    effective_date TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    title          TEXT,
    vault_name     TEXT NOT NULL DEFAULT 'Notes',
    indexed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    fields_text    TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, tags, context, body, type, doc_id UNINDEXED, fields,
    tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    chunk_text    TEXT NOT NULL,
    chunk_source  TEXT NOT NULL DEFAULT 'body',
    token_count   INTEGER,
    UNIQUE(document_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS tags (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (document_id, tag)
);
CREATE TABLE IF NOT EXISTS metadata (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    PRIMARY KEY (document_id, key)
);
CREATE TABLE IF NOT EXISTS context_descriptions (
    context     TEXT PRIMARY KEY,
    description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embedding_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_context ON documents(context);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_effective_date ON documents(effective_date);
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_metadata_key ON metadata(key, value);
`;

// Created after migrate(), since an older DB's `documents` table only gains
// columns there.
const POST_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_documents_vault ON documents(vault_name);
`;

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * Bring a DB created by an older qkb up to the current schema, in place and
 * without re-embedding:
 *
 * - `documents.fields_text` (declared extra properties, rendered as
 *   `key: value` lines) — added with an empty default.
 * - `documents_fts.fields` — FTS5 tables can't ALTER ADD COLUMN, so the table
 *   is rebuilt from its own stored columns (it's a content-storing FTS table,
 *   so the body is still there) with an empty `fields` column. `fields` sits
 *   AFTER the UNINDEXED `doc_id` so the existing bm25() weight positions for
 *   title/tags/context/body/type don't move.
 */
function migrate(db: Database.Database): void {
  if (!columnNames(db, "documents").includes("fields_text")) {
    db.exec("ALTER TABLE documents ADD COLUMN fields_text TEXT NOT NULL DEFAULT ''");
  }
  if (!columnNames(db, "documents_fts").includes("fields")) {
    db.transaction(() => {
      db.exec(
        "CREATE VIRTUAL TABLE documents_fts_migrated USING fts5(" +
          "title, tags, context, body, type, doc_id UNINDEXED, fields, " +
          "tokenize='porter unicode61')",
      );
      db.exec(
        "INSERT INTO documents_fts_migrated (title, tags, context, body, type, doc_id, fields) " +
          "SELECT title, tags, context, body, type, doc_id, '' FROM documents_fts",
      );
      db.exec("DROP TABLE documents_fts");
      db.exec("ALTER TABLE documents_fts_migrated RENAME TO documents_fts");
    })();
  }
}

/**
 * Build a `?,?,...` SQL IN-list placeholder string for `n` parameters.
 *
 * Shared helper for the several call sites that each need a dynamic IN-list
 * (results, filters/tags, storage's chunk deletes) — ported from db.py.
 */
export function placeholders(n: number): string {
  return Array(n).fill("?").join(",");
}

function createVectorTable(db: Database.Database, embeddingDim: number): void {
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(" +
      `chunk_id INTEGER PRIMARY KEY, embedding float[${embeddingDim}] distance_metric=cosine)`,
  );
}

/**
 * Drop and recreate `chunks_vec` at the given dimension.
 *
 * `chunks_vec` keeps whatever dimension it was first created with; a `vec0`
 * virtual table can't be altered in place. Used by a `--full` re-embed when
 * the configured embedding model/dimension changes, so the first insert at
 * the new dimension doesn't crash with a raw sqlite-vec error. All existing
 * vectors are discarded — the caller must re-embed every document afterward.
 */
export function rebuildVectorTable(db: Database.Database, embeddingDim: number): void {
  db.exec("DROP TABLE IF EXISTS chunks_vec");
  createVectorTable(db, embeddingDim);
}

/**
 * Return the dimension `chunks_vec` was created at, or null if it doesn't exist.
 *
 * Read authoritatively from the stored DDL rather than tracked state: a vec0
 * virtual table can't be altered in place, so whatever dimension is baked
 * into its `CREATE VIRTUAL TABLE` statement is the dimension inserts must
 * match. Used by `ingest_vault`'s `--full` path to decide whether a rebuild
 * is actually needed — only DROP/recreate when the dimension changed, so a
 * concurrent reader doesn't see an empty index for the whole run when the
 * dimension is unchanged.
 */
export function vectorTableDimension(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
    .get() as { sql: string | null } | undefined;
  if (row === undefined || row.sql === null) {
    return null;
  }
  const match = row.sql.match(/float\[(\d+)\]/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return Number(match[1]);
}

/**
 * Open (creating if needed) the qkb SQLite database and ensure the schema
 * and vector table exist.
 *
 * Integer handling: this module does not enable `defaultSafeIntegers`, so
 * reads come back as plain JS `number` (chunk ids, dimensions) everywhere,
 * including from `chunks_vec`. Writing `chunk_id` into `chunks_vec` is the
 * one exception — as a vec0 virtual-table INTEGER PRIMARY KEY, it rejects a
 * plain `number` bound by better-sqlite3 (bound as REAL) and requires a
 * BigInt (e.g. `1n`) on insert; ordinary `documents`/`chunks` tables accept
 * plain numbers for INTEGER columns either way. Callers inserting into
 * `chunks_vec` must bind `chunk_id` as BigInt.
 */
export function connect(dbPath: string, embeddingDim: number): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("foreign_keys = ON");
  // A long-running server reads while `qkb ingest`/`embed` (or the server's
  // own watch loop, on a second connection) writes. WAL lets readers and the
  // one writer proceed concurrently; busy_timeout makes a second writer wait
  // for the lock instead of failing at once with "database is locked".
  db.pragma("busy_timeout = 5000");
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA_SQL);
  migrate(db);
  db.exec(POST_MIGRATION_SQL);
  createVectorTable(db, embeddingDim);
  return db;
}
