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
        total_chunks = conn.execute(
            "SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id "
            f"WHERE {clause}",
            params,
        ).fetchone()[0]
    else:
        total_chunks = conn.execute("SELECT COUNT(*) FROM chunks_vec").fetchone()[0]
    if total_chunks == 0:
        return []
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
    qvec_bytes = sqlite_vec.serialize_float32(qvec)
    # The KNN pool must be at least as large as the requested output limit,
    # or a large `limit` gets silently truncated to a smaller fixed candidate
    # count (review finding 6). But `k` sizes a pool of CHUNKS while the
    # result loop below dedups to best-chunk-per-DOCUMENT and stops at
    # `limit` documents — on any vault whose docs average more than one
    # chunk, a few long documents can crowd the chunk pool and starve the
    # document-level result set (review finding 3). So grow the pool
    # iteratively until `limit` distinct documents are collected or the
    # candidate chunk set is exhausted, rather than sizing it once from
    # `candidates`/`limit` alone.
    k = min(max(candidates, limit), total_chunks)
    while True:
        rows = conn.execute(sql, [qvec_bytes, k, *params]).fetchall()
        out: list[tuple[str, float, str]] = []
        seen: set[str] = set()
        for r in rows:  # already best-first; keep best chunk per document
            if r["doc_id"] in seen:
                continue
            seen.add(r["doc_id"])
            out.append((r["doc_id"], r["score"], r["chunk_text"]))
            if len(out) >= limit:
                break
        if len(out) >= limit or k >= total_chunks:
            break
        k = min(k * 2, total_chunks)
    return out[:limit]
