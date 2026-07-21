"""Hydrate ranked doc ids into the full result JSON contract (DESIGN.md §8.6)."""

from __future__ import annotations

import sqlite3
from urllib.parse import quote

from qkb.db import placeholders


def obsidian_uri(vault_name: str, file_path: str) -> str:
    path = file_path.removesuffix(".md")
    return f"obsidian://open?vault={quote(vault_name, safe='')}&file={quote(path, safe='')}"


def context_description(conn: sqlite3.Connection, context: str | None) -> str | None:
    if not context:
        return None
    row = conn.execute(
        "SELECT description FROM context_descriptions WHERE context = ?", (context,)
    ).fetchone()
    return row["description"] if row else None


def _batch_doc_rows(conn: sqlite3.Connection, doc_ids: list[str]) -> dict[str, sqlite3.Row]:
    if not doc_ids:
        return {}
    rows = conn.execute(
        f"SELECT * FROM documents WHERE id IN ({placeholders(len(doc_ids))})", doc_ids
    ).fetchall()
    return {r["id"]: r for r in rows}


def _batch_tags(conn: sqlite3.Connection, doc_ids: list[str]) -> dict[str, list[str]]:
    tags_by_doc: dict[str, list[str]] = {doc_id: [] for doc_id in doc_ids}
    if not doc_ids:
        return tags_by_doc
    rows = conn.execute(
        "SELECT document_id, tag FROM tags WHERE document_id IN "
        f"({placeholders(len(doc_ids))}) ORDER BY tag",
        doc_ids,
    ).fetchall()
    for r in rows:
        tags_by_doc[r["document_id"]].append(r["tag"])
    return tags_by_doc


def _batch_context_descriptions(conn: sqlite3.Connection, contexts: list[str]) -> dict[str, str]:
    unique = sorted({c for c in contexts if c})
    if not unique:
        return {}
    rows = conn.execute(
        "SELECT context, description FROM context_descriptions WHERE context IN "
        f"({placeholders(len(unique))})",
        unique,
    ).fetchall()
    return {r["context"]: r["description"] for r in rows}


def _batch_siblings(conn: sqlite3.Connection, sources: list[str]) -> dict[str, list[sqlite3.Row]]:
    """All sibling candidate rows grouped by source, ordered by title (so the
    per-doc filtering below just excludes self, preserving title order)."""
    unique = sorted({s for s in sources if s})
    siblings_by_source: dict[str, list[sqlite3.Row]] = {s: [] for s in unique}
    if not unique:
        return siblings_by_source
    rows = conn.execute(
        "SELECT id, title, type, file_path, vault_name, source FROM documents "
        f"WHERE source IN ({placeholders(len(unique))}) ORDER BY title",
        unique,
    ).fetchall()
    for r in rows:
        siblings_by_source[r["source"]].append(r)
    return siblings_by_source


def hydrate(conn: sqlite3.Connection, ranked: list[tuple[str, float, str | None]]) -> list[dict]:
    doc_ids = [doc_id for doc_id, _, _ in ranked]
    doc_rows = _batch_doc_rows(conn, doc_ids)
    present_ids = [doc_id for doc_id in doc_ids if doc_id in doc_rows]

    tags_by_doc = _batch_tags(conn, present_ids)
    contexts = [doc_rows[doc_id]["context"] for doc_id in present_ids]
    descriptions_by_context = _batch_context_descriptions(conn, contexts)
    sources = [doc_rows[doc_id]["source"] for doc_id in present_ids]
    siblings_by_source = _batch_siblings(conn, sources)

    out: list[dict] = []
    for doc_id, score, matched_text in ranked:
        d = doc_rows.get(doc_id)
        if d is None:
            continue
        siblings = [
            {
                "document_id": r["id"],
                "title": r["title"],
                "type": r["type"],
                "file_path": r["file_path"],
                "obsidian_uri": obsidian_uri(r["vault_name"], r["file_path"]),
            }
            for r in siblings_by_source.get(d["source"], [])
            if r["id"] != doc_id
        ]
        out.append(
            {
                "document_id": d["id"],
                "title": d["title"],
                "type": d["type"],
                "context": d["context"],
                "context_description": descriptions_by_context.get(d["context"]),
                "source": d["source"],
                "effective_date": d["effective_date"],
                "score": round(score, 6),
                "file_path": d["file_path"],
                "obsidian_uri": obsidian_uri(d["vault_name"], d["file_path"]),
                "matched_text": matched_text,
                "tags": tags_by_doc.get(doc_id, []),
                "siblings": siblings,
            }
        )
    return out
