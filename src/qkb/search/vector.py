"""Chunk-level vector search, deduplicated to documents (DESIGN.md §8.1 tier 2)."""

from __future__ import annotations

import sqlite3

import sqlite_vec

from qkb.embed.base import EmbeddingProvider
from qkb.search.filters import Filters, build_filter_clause


def search_vector(
    conn: sqlite3.Connection,
    query: str,
    filters: Filters,
    limit: int,
    candidates: int,
    provider: EmbeddingProvider,
) -> list[tuple[str, float, str]]:
    qvec = provider.embed_query(query)
    clause, params = build_filter_clause(filters)
    has_filters = clause != "1=1"
    k = candidates * 4 if has_filters else candidates
    sql = f"""
        WITH knn AS (
            SELECT chunk_id, distance
            FROM chunks_vec
            WHERE embedding MATCH ? AND k = ?
        )
        SELECT c.document_id AS doc_id,
               1.0 - knn.distance AS score,
               c.chunk_text AS chunk_text
        FROM knn
        JOIN chunks c ON c.id = knn.chunk_id
        JOIN documents d ON d.id = c.document_id
        WHERE {clause}
        ORDER BY knn.distance ASC
    """
    rows = conn.execute(sql, [sqlite_vec.serialize_float32(qvec), k, *params]).fetchall()
    out: list[tuple[str, float, str]] = []
    seen: set[str] = set()
    for r in rows:  # already best-first; keep best chunk per document
        if r["doc_id"] in seen:
            continue
        seen.add(r["doc_id"])
        out.append((r["doc_id"], r["score"], r["chunk_text"]))
        if len(out) >= limit:
            break
    return out
