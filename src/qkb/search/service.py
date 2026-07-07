"""Shared search orchestration for the CLI and MCP entry points (review finding: MCP
was drifting from the CLI — hardcoded limit=10, duplicated the tiered-search call
inline). Both `cli._do_search` and the MCP `qkb` tool call `execute_search` so the
"resolve limit -> validate -> run tiered search -> hydrate" pipeline can't diverge.
"""

from __future__ import annotations

import sqlite3

from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
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
        ValueError: if the resolved limit is < 1. `--limit 0`/negative is
            rejected rather than silently becoming "unbounded" (SQLite
            ``LIMIT -1``) or "10" (falsy-``or`` bug) — see review below-the-cut
            finding on `cli.py`.
    """
    resolved_limit = limit if limit is not None else cfg.default_limit
    if resolved_limit < 1:
        raise ValueError(f"limit must be >= 1, got {resolved_limit}")
    ranked = run_search(conn, cfg, provider, query, filters, resolved_limit, tier)
    return hydrate(conn, ranked)
