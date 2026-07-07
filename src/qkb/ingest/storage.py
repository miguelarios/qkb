"""SQLite write operations. Each public method is one transaction."""

from __future__ import annotations

import hashlib
import sqlite3

import sqlite_vec

from qkb.models import Chunk, ParsedNote


def content_hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


class Storage:
    def __init__(self, conn: sqlite3.Connection, vault_name: str = "Notes"):
        self.conn = conn
        self.vault_name = vault_name

    def get_content_hash(self, doc_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT content_hash FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        return row["content_hash"] if row else None

    def all_indexed_ids(self) -> set[str]:
        return {r["id"] for r in self.conn.execute("SELECT id FROM documents")}

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

    def _write_tags_and_metadata(self, note: ParsedNote) -> None:
        self.conn.execute("DELETE FROM tags WHERE document_id = ?", (note.id,))
        self.conn.executemany(
            "INSERT INTO tags (document_id, tag) VALUES (?,?)",
            [(note.id, t) for t in dict.fromkeys(note.tags)],
        )
        self.conn.execute("DELETE FROM metadata WHERE document_id = ?", (note.id,))
        self.conn.executemany(
            "INSERT INTO metadata (document_id, key, value) VALUES (?,?,?)",
            [(note.id, k, v) for k, v in note.extra_metadata.items()],
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
            self._write_tags_and_metadata(note)
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

    def update_metadata_only(self, note: ParsedNote, chash: str) -> None:
        with self.conn:
            self._write_doc_row(note, chash)
            self._write_fts_row(note)
            self._write_tags_and_metadata(note)

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
            with self.conn:
                self.conn.executemany(
                    "INSERT INTO embedding_config (key, value) VALUES (?,?)",
                    [("model_name", model_name), ("embedding_dim", str(dim))],
                )
            return True
        return rows.get("model_name") == model_name and rows.get("embedding_dim") == str(dim)

    def reset_embedding_config(self) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM embedding_config")

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
