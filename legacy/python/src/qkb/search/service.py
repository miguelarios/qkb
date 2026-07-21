"""Shared search orchestration for the CLI and MCP entry points (review finding: MCP
was drifting from the CLI — hardcoded limit=10, duplicated the tiered-search call
inline). Both `cli._do_search` and the MCP `qkb` tool call `execute_search` so the
"resolve limit -> validate -> run tiered search -> hydrate" pipeline can't diverge.
"""

from __future__ import annotations

import sqlite3

from qkb import db
from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
from qkb.ingest.storage import Storage
from qkb.search.filters import Filters
from qkb.search.hybrid import search as run_search
from qkb.search.results import hydrate


def execute_search(
    conn: sqlite3.Connection,
    cfg: Config,
    provider: EmbeddingProvider | None,
    query: str,
    filters: Filters,
    limit: int | None,
    tier: str,
) -> list[dict]:
    """Resolve `limit` (``None`` -> ``cfg.default_limit``), reject a resolved
    limit below 1, run the tiered search, and hydrate the ranked ids into full
    result dicts.

    Raises:
        ValueError: if a `--full` re-embed is in progress or was interrupted
            (review finding 2 — an untrustworthy index must not be searched
            silently); if the resolved limit is < 1 (`--limit 0`/negative is
            rejected rather than silently becoming "unbounded" (SQLite
            ``LIMIT -1``) or "10" (falsy-``or`` bug) — see review below-the-cut
            finding on `cli.py`); or, for vector-using tiers, if `chunks_vec`
            was built at a different embedding dimension than `cfg` now
            expects (review finding 5 — surfaces a friendly error instead of
            sqlite-vec's raw `OperationalError`).
    """
    if Storage(conn).is_ingest_in_progress():
        raise ValueError(
            "index rebuild in progress or interrupted — re-run `qkb ingest --full` "
            "to finish re-embedding before searching"
        )
    resolved_limit = limit if limit is not None else cfg.default_limit
    if resolved_limit < 1:
        raise ValueError(f"limit must be >= 1, got {resolved_limit}")
    if tier != "bm25":
        table_dim = db.vector_table_dimension(conn)
        if table_dim is not None and table_dim != cfg.embedding_dim:
            raise ValueError(
                f"embedding dimension changed since last ingest "
                f"(index is {table_dim}-d, config is {cfg.embedding_dim}-d) — "
                f"run `qkb ingest --full` to re-embed the whole vault"
            )
    ranked = run_search(conn, cfg, provider, query, filters, resolved_limit, tier)
    return hydrate(conn, ranked)
