"""SQLite write operations. Each public method is one transaction."""

from __future__ import annotations

import hashlib
import sqlite3

import sqlite_vec

from qkb.db import rebuild_vector_table
from qkb.models import Chunk, ParsedNote


def content_hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


# Reserved key in the `metadata` KV table used to stash a hash of the
# frontmatter-derived fields for a document (see `metadata_hash` below). No
# schema migration is needed for this: it reuses the existing `metadata` table
# rather than adding a `documents.metadata_hash` column, which would require an
# `ALTER TABLE` migration guard for pre-existing DBs (db.py's `connect()` uses
# `CREATE TABLE IF NOT EXISTS`, which does not add columns to an already-created
# table). A DB ingested before this fix simply has no row under this key yet;
# `get_metadata_hash` returns None, so the first post-upgrade ingest treats
# metadata as "changed" (one legitimate write that populates the hash), and
# every ingest after that is a true no-op. The leading/trailing dunders make an
# accidental collision with a real frontmatter `extra_metadata` key vanishingly
# unlikely - and a crafted collision is handled: the parser strips this key and
# `_write_tags_and_metadata` filters it, so it can never be written as user
# metadata alongside the reserved-hash row (which would violate the PK).
_METADATA_HASH_KEY = "__qkb_meta_hash__"

# Sentinel key in the same `embedding_config` KV table marking "a --full
# re-embed is currently in progress / did not complete". See
# `mark_ingest_in_progress`/`clear_ingest_in_progress`/`is_ingest_in_progress`
# below. Distinct from "model_name"/"embedding_dim" (the only two keys
# `check_embedding_config` compares), so its presence never perturbs that
# comparison.
_INGEST_IN_PROGRESS_KEY = "ingest_in_progress"


# Delimiters for metadata_hash serialization. Distinct ASCII control characters
# (unlikely to appear in real frontmatter values) at each nesting level, so no
# choice of field/list/pair boundary is ambiguous: e.g. tags ["a,b"] and
# ["a","b"] must not collide (they would if list items were comma-joined). US =
# field separator, RS = list-item separator, GS = key/value separator.
_FIELD_SEP = "\x1f"
_ITEM_SEP = "\x1e"
_KV_SEP = "\x1d"


def metadata_hash(note: ParsedNote, vault_name: str = "Notes") -> str:
    """Stable hash over every non-body column `update_metadata_if_changed` is
    responsible for keeping in sync when the body is unchanged: title, type,
    context, source, effective_date, created_at, tags, extra_metadata, AND
    file_path + vault_name.

    file_path/vault_name are folded in deliberately: a pure rename (same id,
    body, and frontmatter) changes neither `content_hash` nor the other
    frontmatter fields, so without them the fast path would skip the write and
    leave `documents.file_path` pointing at a now-nonexistent path forever,
    breaking raw-content reads and obsidian:// links. Body is excluded (covered
    by `content_hash`) so a body-only change isn't mistaken for a metadata one.
    """
    parts = [
        note.title or "",
        note.type,
        note.context or "",
        note.source or "",
        note.effective_date,
        note.created_at,
        note.file_path,
        vault_name,
        _ITEM_SEP.join(sorted(note.tags)),
        _ITEM_SEP.join(f"{k}{_KV_SEP}{v}" for k, v in sorted(note.extra_metadata.items())),
    ]
    return hashlib.sha256(_FIELD_SEP.join(parts).encode()).hexdigest()


class Storage:
    def __init__(self, conn: sqlite3.Connection, vault_name: str = "Notes"):
        self.conn = conn
        self.vault_name = vault_name

    def get_content_hash(self, doc_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT content_hash FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        return row["content_hash"] if row else None

    def get_metadata_hash(self, doc_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT value FROM metadata WHERE document_id = ? AND key = ?",
            (doc_id, _METADATA_HASH_KEY),
        ).fetchone()
        return row["value"] if row else None

    def all_indexed_ids(self) -> set[str]:
        return {r["id"] for r in self.conn.execute("SELECT id FROM documents")}

    def indexed_paths(self) -> dict[str, str]:
        """Map of vault-relative file_path -> document id for indexed documents.

        Used by the ingest deletion sweep to resolve a path that failed to parse
        this run back to the doc id it previously indexed, so a transient parse
        error doesn't get treated as a file deletion.
        """
        return {
            r["file_path"]: r["id"]
            for r in self.conn.execute("SELECT id, file_path FROM documents")
        }

    def _write_doc_row(self, note: ParsedNote, chash: str) -> None:
        self.conn.execute(
            """INSERT INTO documents
               (id, type, context, source, effective_date, created_at,
                file_path, content_hash, title, vault_name)
               VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 type=excluded.type, context=excluded.context, source=excluded.source,
                 effective_date=excluded.effective_date, created_at=excluded.created_at,
                 file_path=excluded.file_path, content_hash=excluded.content_hash,
                 title=excluded.title, vault_name=excluded.vault_name,
                 indexed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
            (
                note.id,
                note.type,
                note.context,
                note.source,
                note.effective_date,
                note.created_at,
                note.file_path,
                chash,
                note.title,
                self.vault_name,
            ),
        )

    def _write_fts_row(self, note: ParsedNote) -> None:
        self.conn.execute("DELETE FROM documents_fts WHERE doc_id = ?", (note.id,))
        self.conn.execute(
            "INSERT INTO documents_fts (title, tags, context, body, type, doc_id) "
            "VALUES (?,?,?,?,?,?)",
            (note.title, " ".join(note.tags), note.context or "", note.body, note.type, note.id),
        )

    def _write_tags_and_metadata(self, note: ParsedNote, mhash: str) -> None:
        self.conn.execute("DELETE FROM tags WHERE document_id = ?", (note.id,))
        self.conn.executemany(
            "INSERT INTO tags (document_id, tag) VALUES (?,?)",
            [(note.id, t) for t in dict.fromkeys(note.tags)],
        )
        self.conn.execute("DELETE FROM metadata WHERE document_id = ?", (note.id,))
        # Drop any user frontmatter key colliding with our reserved hash key: it
        # and the reserved-hash row would share the (document_id, key) PK, and
        # one executemany with both would raise IntegrityError, aborting the
        # ENTIRE ingest run (pipeline.py only wraps parse_note in try/except, not
        # the storage write) - a full-vault DoS from a single crafted note. The
        # parser also strips it defensively; this is the belt-and-suspenders half.
        rows = [(note.id, k, v) for k, v in note.extra_metadata.items() if k != _METADATA_HASH_KEY]
        rows.append((note.id, _METADATA_HASH_KEY, mhash))
        self.conn.executemany(
            "INSERT INTO metadata (document_id, key, value) VALUES (?,?,?)",
            rows,
        )

    def upsert(
        self,
        note: ParsedNote,
        chash: str,
        chunks: list[Chunk],
        embeddings: list[list[float]],
    ) -> None:
        with self.conn:
            self._delete_chunks(note.id)
            self._write_doc_row(note, chash)
            self._write_fts_row(note)
            self._write_tags_and_metadata(note, metadata_hash(note, self.vault_name))
            for chunk, vec in zip(chunks, embeddings, strict=True):
                cur = self.conn.execute(
                    "INSERT INTO chunks (document_id, chunk_index, chunk_text, token_count) "
                    "VALUES (?,?,?,?)",
                    (note.id, chunk.index, chunk.text, chunk.token_count),
                )
                self.conn.execute(
                    "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?,?)",
                    (cur.lastrowid, sqlite_vec.serialize_float32(vec)),
                )

    def update_metadata_if_changed(self, note: ParsedNote, chash: str) -> bool:
        """Refresh the documents row, FTS metadata columns, tags, and metadata
        for a document whose body is known unchanged (caller already matched
        `content_hash`) - but ONLY if the frontmatter-derived metadata actually
        changed since the last ingest (finding 10).

        Returns True if a write happened (indexed_at legitimately advances),
        False if this was a true no-op: no transaction opened, nothing written,
        indexed_at untouched. Called for every content-unchanged document on
        every ingest, so the no-op path must stay cheap (a single indexed
        lookup in `metadata`, no writes) - on a large vault this is the
        difference between ~0 writes and one full-body FTS re-tokenization per
        document per cron run.
        """
        mhash = metadata_hash(note, self.vault_name)
        if self.get_metadata_hash(note.id) == mhash:
            return False
        with self.conn:
            self._write_doc_row(note, chash)
            self._write_fts_row(note)
            self._write_tags_and_metadata(note, mhash)
        return True

    def _delete_chunks(self, doc_id: str) -> None:
        ids = [
            r["id"]
            for r in self.conn.execute("SELECT id FROM chunks WHERE document_id = ?", (doc_id,))
        ]
        if ids:
            marks = ",".join("?" * len(ids))
            self.conn.execute(f"DELETE FROM chunks_vec WHERE chunk_id IN ({marks})", ids)
            self.conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))

    def delete(self, doc_id: str) -> None:
        with self.conn:
            self._delete_chunks(doc_id)
            self.conn.execute("DELETE FROM documents_fts WHERE doc_id = ?", (doc_id,))
            self.conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))

    def check_embedding_config(self, model_name: str, dim: int) -> bool:
        rows = {r["key"]: r["value"] for r in self.conn.execute("SELECT * FROM embedding_config")}
        if not rows:
            # Nothing committed yet (fresh DB) - this is the first-ever ingest for this
            # index, so there is no prior model to mix vectors with. Safe to commit now.
            self.commit_embedding_config(model_name, dim)
            return True
        return rows.get("model_name") == model_name and rows.get("embedding_dim") == str(dim)

    def commit_embedding_config(self, model_name: str, dim: int) -> None:
        """Record model_name/dim as the current, committed embedding config.

        Overwrites any prior rows. Callers driving a `--full` re-embed must only
        call this once re-embedding has completed successfully (see
        `ingest_vault`) - otherwise an interrupted run could leave a mix of
        old- and new-model vectors while `check_embedding_config` reports no
        mismatch, which is exactly the corruption the guard exists to prevent.
        """
        with self.conn:
            self.conn.execute("DELETE FROM embedding_config")
            self.conn.executemany(
                "INSERT INTO embedding_config (key, value) VALUES (?,?)",
                [("model_name", model_name), ("embedding_dim", str(dim))],
            )

    def rebuild_vector_index(self, embedding_dim: int) -> None:
        """Drop and recreate the chunks_vec vector index at `embedding_dim`.

        Used at the start of a `--full` re-embed so a model/dimension change
        doesn't crash on the first insert at the new dimension (finding 1).
        """
        rebuild_vector_table(self.conn, embedding_dim)

    def mark_ingest_in_progress(self) -> None:
        """Set the `ingest_in_progress` sentinel in `embedding_config`.

        Called at the START of a `--full` re-embed (before the document loop)
        so an interruption partway through - even with the SAME model/dim as
        before - is detectable on the next plain ingest. Without this, an
        interrupted same-model `--full` leaves un-reached docs with orphaned
        `chunks` rows but no `chunks_vec` entries: `check_embedding_config`
        only fires on a model/dim MISMATCH, so those docs would silently
        vanish from vector/hybrid search forever (finding 3 generalized).
        Uses the existing `embedding_config` KV table rather than a new
        column/table - no schema migration needed.
        """
        with self.conn:
            self.conn.execute(
                "INSERT INTO embedding_config (key, value) VALUES (?, '1') "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (_INGEST_IN_PROGRESS_KEY,),
            )

    def clear_ingest_in_progress(self) -> None:
        """Clear the `ingest_in_progress` sentinel.

        Called at the very end of a `--full` re-embed, right after
        `commit_embedding_config` - so an exception anywhere between
        `mark_ingest_in_progress` and here leaves the sentinel SET. In
        practice `commit_embedding_config` already wipes the whole
        `embedding_config` table (including this key) on a clean run; this
        call is the explicit, order-independent guarantee.
        """
        with self.conn:
            self.conn.execute(
                "DELETE FROM embedding_config WHERE key = ?", (_INGEST_IN_PROGRESS_KEY,)
            )

    def is_ingest_in_progress(self) -> bool:
        row = self.conn.execute(
            "SELECT value FROM embedding_config WHERE key = ?", (_INGEST_IN_PROGRESS_KEY,)
        ).fetchone()
        return row is not None and row["value"] == "1"

    def set_context_description(self, context: str, description: str | None) -> None:
        with self.conn:
            if description is None:
                self.conn.execute("DELETE FROM context_descriptions WHERE context = ?", (context,))
            else:
                self.conn.execute(
                    "INSERT INTO context_descriptions (context, description) VALUES (?,?) "
                    "ON CONFLICT(context) DO UPDATE SET description=excluded.description",
                    (context, description),
                )

    def list_contexts(self) -> list[dict]:
        rows = self.conn.execute(
            """SELECT d.context AS context, COUNT(*) AS count, cd.description AS description
               FROM documents d
               LEFT JOIN context_descriptions cd ON cd.context = d.context
               WHERE d.context IS NOT NULL
               GROUP BY d.context ORDER BY count DESC, d.context"""
        ).fetchall()
        return [dict(r) for r in rows]

    def stats(self) -> dict:
        docs = self.conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"]
        chunks = self.conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
        last = self.conn.execute("SELECT MAX(indexed_at) m FROM documents").fetchone()["m"]
        return {
            "documents": docs,
            "chunks": chunks,
            "contexts": self.list_contexts(),
            "last_indexed_at": last,
        }
