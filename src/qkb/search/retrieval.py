"""Document retrieval by UUID or prefix, three formats (DESIGN.md §8.8)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from qkb.search.results import context_description, hydrate

_LIKE_ESCAPE = "\\"


class DocumentFileMissing(FileNotFoundError):
    """Raised when a document's on-disk file is gone since the last ingest.

    Subclasses FileNotFoundError so callers that only expect the builtin
    still catch it, while giving CLI/MCP a specific type to match on for a
    friendly message.
    """


def _escape_like_prefix(raw: str) -> str:
    """Escape LIKE metacharacters so `raw` matches only literally, then
    append the trailing wildcard for prefix matching."""
    escaped = (
        raw.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", _LIKE_ESCAPE + "%")
        .replace("_", _LIKE_ESCAPE + "_")
    )
    return escaped + "%"


def get_document(
    conn: sqlite3.Connection,
    id_or_prefix: str,
    vault_path: Path | None = None,
    include_raw: bool = False,
    include_siblings: bool = True,
) -> dict:
    rows = conn.execute(
        f"SELECT id FROM documents WHERE id LIKE ? ESCAPE '{_LIKE_ESCAPE}'",
        (_escape_like_prefix(id_or_prefix),),
    ).fetchall()
    if not rows:
        raise KeyError(f"no document with id (prefix) {id_or_prefix!r}")
    if len(rows) > 1:
        raise ValueError(f"ambiguous prefix {id_or_prefix!r} matches {len(rows)} documents")
    doc = hydrate(conn, [(rows[0]["id"], 0.0, None)])[0]
    del doc["score"], doc["matched_text"]
    if not include_siblings:
        doc["siblings"] = []
    if include_raw:
        if vault_path is None:
            raise ValueError("include_raw requires vault_path")
        file_path = vault_path / doc["file_path"]
        try:
            text = file_path.read_text(encoding="utf-8")
        except FileNotFoundError as e:
            raise DocumentFileMissing(
                f"file moved or deleted since last ingest: {doc['file_path']!r} "
                f"(document {doc['document_id']!r}) — re-run `qkb ingest`"
            ) from e
        except OSError as e:
            # Below-the-cut: FileNotFoundError is the common case (moved/deleted
            # since last ingest) and gets the friendly message above. Anything
            # else OSError-shaped (PermissionError, IsADirectoryError, ...) still
            # means "can't read this document's file" and should surface as the
            # same typed, catchable error rather than a raw traceback.
            # (UnicodeDecodeError subclasses ValueError, not OSError, and is
            # already handled by callers expecting ValueError.)
            raise DocumentFileMissing(
                f"cannot read file {doc['file_path']!r} (document {doc['document_id']!r}): {e}"
            ) from e
        desc = context_description(conn, doc["context"])
        if desc:
            text = f"<!-- Context: {desc} -->\n\n{text}"
        doc["raw_text"] = text
    return doc
