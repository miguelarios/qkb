"""SQLite connection + schema. Single source of DDL truth (DESIGN.md §6)."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import sqlite_vec

_SCHEMA = """
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
"""


def _create_vector_table(conn: sqlite3.Connection, embedding_dim: int) -> None:
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0("
        f"chunk_id INTEGER PRIMARY KEY, embedding float[{embedding_dim}] distance_metric=cosine)"
    )


def rebuild_vector_table(conn: sqlite3.Connection, embedding_dim: int) -> None:
    """Drop and recreate ``chunks_vec`` at the given dimension.

    ``chunks_vec`` keeps whatever dimension it was first created with; a `vec0`
    virtual table can't be altered in place. Used by a `--full` re-embed when
    the configured embedding model/dimension changes, so the first insert at
    the new dimension doesn't crash with a raw sqlite-vec error. All existing
    vectors are discarded — the caller must re-embed every document afterward.
    """
    conn.execute("DROP TABLE IF EXISTS chunks_vec")
    _create_vector_table(conn, embedding_dim)
    conn.commit()


def vector_table_dimension(conn: sqlite3.Connection) -> int | None:
    """Return the dimension `chunks_vec` was created at, or None if it doesn't exist.

    Read authoritatively from the stored DDL rather than tracked state: a vec0
    virtual table can't be altered in place, so whatever dimension is baked
    into its `CREATE VIRTUAL TABLE` statement is the dimension inserts must
    match. Used by `ingest_vault`'s `--full` path to decide whether a rebuild
    is actually needed (finding 2: only DROP/recreate when the dimension
    changed, so a concurrent reader doesn't see an empty index for the whole
    run when the dimension is unchanged).
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    ).fetchone()
    if row is None:
        return None
    match = re.search(r"float\[(\d+)\]", row["sql"])
    if match is None:
        return None
    return int(match.group(1))


def connect(db_path: Path, embedding_dim: int) -> sqlite3.Connection:
    if str(db_path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    if not hasattr(conn, "enable_load_extension"):
        raise RuntimeError(
            "This Python's sqlite3 lacks extension loading (needed for sqlite-vec). "
            "Use a python.org, uv, or Homebrew Python."
        )
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(_SCHEMA)
    _create_vector_table(conn, embedding_dim)
    conn.commit()
    return conn
