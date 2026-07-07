"""Document-level BM25 via FTS5 weighted columns (ADR-005/007)."""

from __future__ import annotations

import re
import sqlite3

from qkb.search.filters import Filters, build_filter_clause


def sanitize_query(query: str) -> str:
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    return " ".join(f'"{t}"' for t in tokens)


def search_bm25(
    conn: sqlite3.Connection,
    query: str,
    filters: Filters,
    limit: int,
    weights: list[float],
) -> list[tuple[str, float, str]]:
    match = sanitize_query(query)
    if not match:
        return []
    clause, params = build_filter_clause(filters)
    w = list(weights) + [0.0]  # 6th weight for doc_id UNINDEXED
    # NOTE: no table alias on documents_fts — FTS5 MATCH needs the real table name
    sql = f"""
        SELECT documents_fts.doc_id AS doc_id,
               -bm25(documents_fts, {",".join(str(x) for x in w)}) AS score,
               snippet(documents_fts, 3, '[', ']', '…', 12) AS snip
        FROM documents_fts
        JOIN documents d ON d.id = documents_fts.doc_id
        WHERE documents_fts MATCH ? AND {clause}
        ORDER BY score DESC
        LIMIT ?
    """
    rows = conn.execute(sql, [match, *params, limit]).fetchall()
    return [(r["doc_id"], r["score"], r["snip"]) for r in rows]
