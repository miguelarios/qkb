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
    # The candidate pool must be at least as large as the requested output
    # limit, or a large `limit` gets silently truncated to a smaller fixed
    # candidate count (review finding 6).
    k = max(candidates, limit)
    # When filters are present, restrict the KNN candidate set to
    # filter-passing chunks BEFORE the vector search runs (sqlite-vec's vec0
    # supports constraining MATCH by rowid via `chunk_id IN (...)`), rather
    # than running an unrestricted global top-k search and discarding
    # non-matching rows afterward. The old global-then-filter approach could
    # return zero results even when filter-passing matches exist outside the
    # global top-k (review finding 5; DESIGN.md §8.5 promises the candidate
    # set is restricted before search). No fudge-factor multiplier on `k` is
    # needed anymore: since the pool is already restricted to filter-passing
    # chunks, every row returned already qualifies.
    restrict = ""
    if has_filters:
        restrict = (
            "AND chunk_id IN ("
            "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id "
            f"WHERE {clause})"
        )
    sql = f"""
        WITH knn AS (
            SELECT chunk_id, distance
            FROM chunks_vec
            WHERE embedding MATCH ? AND k = ? {restrict}
        )
        SELECT c.document_id AS doc_id,
               1.0 - knn.distance AS score,
               c.chunk_text AS chunk_text
        FROM knn
        JOIN chunks c ON c.id = knn.chunk_id
        ORDER BY knn.distance ASC
    """
    knn_params: list = [sqlite_vec.serialize_float32(qvec), k, *params]
    rows = conn.execute(sql, knn_params).fetchall()
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
