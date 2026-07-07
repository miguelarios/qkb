"""RRF fusion and search-tier orchestration (DESIGN.md §8.1-8.2)."""

from __future__ import annotations

import sqlite3
from collections import defaultdict

from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
from qkb.search.bm25 import search_bm25
from qkb.search.filters import Filters
from qkb.search.vector import search_vector


def rrf_merge(
    result_lists: list[list[tuple[str, float]]],
    k: int = 60,
    weights: list[float] | None = None,
) -> list[tuple[str, float]]:
    if weights is None:
        weights = [1.0] * len(result_lists)
    scores: dict[str, float] = defaultdict(float)
    for weight, results in zip(weights, result_lists, strict=True):
        for rank, (doc_id, _) in enumerate(results):
            scores[doc_id] += weight * (1.0 / (k + rank + 1))
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def search(
    conn: sqlite3.Connection,
    cfg: Config,
    provider: EmbeddingProvider | None,
    query: str,
    filters: Filters,
    limit: int,
    tier: str,
) -> list[tuple[str, float, str | None]]:
    if tier == "bm25":
        rows = search_bm25(conn, query, filters, limit, cfg.fts_weights)
        return [(d, s, snip) for d, s, snip in rows]
    if provider is None:
        raise ValueError(f"tier {tier!r} requires an embedding provider")
    if tier == "vector":
        rows = search_vector(conn, query, filters, limit, cfg.vec_candidates, provider)
        return [(d, s, text) for d, s, text in rows]
    if tier == "hybrid":
        bm = search_bm25(conn, query, filters, cfg.fts_candidates, cfg.fts_weights)
        vec = search_vector(conn, query, filters, cfg.vec_candidates, cfg.vec_candidates, provider)
        merged = rrf_merge([[(d, s) for d, s, _ in bm], [(d, s) for d, s, _ in vec]], k=cfg.rrf_k)
        chunk_text = {d: t for d, _, t in vec}
        snippet = {d: s for d, _, s in bm}
        return [
            (doc_id, score, chunk_text.get(doc_id) or snippet.get(doc_id))
            for doc_id, score in merged[:limit]
        ]
    raise ValueError(f"unknown tier: {tier!r}")
