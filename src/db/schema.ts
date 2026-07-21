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
    indexed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title, tags, context, body, type, doc_id UNINDEXED,
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
  db.exec(SCHEMA_SQL);
  createVectorTable(db, embeddingDim);
  return db;
}
