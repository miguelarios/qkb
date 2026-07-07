"""Hydrate ranked doc ids into the full result JSON contract (DESIGN.md §8.6)."""

from __future__ import annotations

import sqlite3
from urllib.parse import quote


def obsidian_uri(vault_name: str, file_path: str) -> str:
    path = file_path.removesuffix(".md")
    return f"obsidian://open?vault={quote(vault_name, safe='')}&file={quote(path, safe='')}"


def _doc_row(conn: sqlite3.Connection, doc_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()


def _siblings(conn: sqlite3.Connection, doc_id: str, source: str | None) -> list[dict]:
    if not source:
        return []
    rows = conn.execute(
        "SELECT id, title, type, file_path, vault_name FROM documents "
        "WHERE source = ? AND id != ? ORDER BY title",
        (source, doc_id),
    ).fetchall()
    return [
        {
            "document_id": r["id"],
            "title": r["title"],
            "type": r["type"],
            "file_path": r["file_path"],
            "obsidian_uri": obsidian_uri(r["vault_name"], r["file_path"]),
        }
        for r in rows
    ]


def context_description(conn: sqlite3.Connection, context: str | None) -> str | None:
    if not context:
        return None
    row = conn.execute(
        "SELECT description FROM context_descriptions WHERE context = ?", (context,)
    ).fetchone()
    return row["description"] if row else None


def hydrate(conn: sqlite3.Connection, ranked: list[tuple[str, float, str | None]]) -> list[dict]:
    out: list[dict] = []
    for doc_id, score, matched_text in ranked:
        d = _doc_row(conn, doc_id)
        if d is None:
            continue
        tags = [
            r["tag"]
            for r in conn.execute(
                "SELECT tag FROM tags WHERE document_id = ? ORDER BY tag", (doc_id,)
            )
        ]
        out.append(
            {
                "document_id": d["id"],
                "title": d["title"],
                "type": d["type"],
                "context": d["context"],
                "context_description": context_description(conn, d["context"]),
                "source": d["source"],
                "effective_date": d["effective_date"],
                "score": round(score, 6),
                "file_path": d["file_path"],
                "obsidian_uri": obsidian_uri(d["vault_name"], d["file_path"]),
                "matched_text": matched_text,
                "tags": tags,
                "siblings": _siblings(conn, doc_id, d["source"]),
            }
        )
    return out
