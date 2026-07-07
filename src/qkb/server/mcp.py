"""MCP stdio server exposing qkb search to LLM agents (DESIGN.md §9.2)."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from qkb.config import Config, load_config
from qkb.db import connect
from qkb.embed import get_provider
from qkb.ingest.storage import Storage
from qkb.search.filters import Filters
from qkb.search.hybrid import search as run_search
from qkb.search.results import hydrate
from qkb.search.retrieval import get_document


def build_server(cfg: Config | None = None) -> FastMCP:
    cfg = cfg or load_config()
    server = FastMCP("qkb")

    def _conn():
        return connect(cfg.db_path, cfg.embedding_dim)

    @server.tool(
        name="qkb",
        description=(
            "Search the personal knowledge base (Obsidian vault) with hybrid "
            "BM25 + vector retrieval. Filter by context, type, tags, or date range. "
            "Results include sibling documents and context descriptions."
        ),
    )
    def qkb(
        query: str,
        context: str | None = None,
        type: str | None = None,  # noqa: A002 - MCP param name per spec
        tags: list[str] | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        limit: int = 10,
        rerank: bool = False,
    ) -> dict:
        if rerank:
            return {"result": [{"error": "re-ranking not configured (Phase 2)"}]}
        conn = _conn()
        try:
            ranked = run_search(
                conn,
                cfg,
                get_provider(cfg),
                query,
                Filters(
                    context=context,
                    doc_type=type,
                    tags=tags,
                    date_from=date_from,
                    date_to=date_to,
                ),
                limit,
                "hybrid",
            )
            return {"result": hydrate(conn, ranked)}
        finally:
            conn.close()

    @server.tool(
        name="qkb_get",
        description="Retrieve a document by UUID (full or prefix): metadata, file path, "
        "obsidian:// URI, siblings, and optionally the raw markdown body.",
    )
    def qkb_get(document_id: str, include_raw: bool = False, include_siblings: bool = True) -> dict:
        conn = _conn()
        try:
            return get_document(
                conn,
                document_id,
                vault_path=cfg.vault_path,
                include_raw=include_raw,
                include_siblings=include_siblings,
            )
        finally:
            conn.close()

    @server.tool(
        name="qkb_status",
        description="Index health: document/chunk counts, context list with "
        "descriptions, last ingestion time.",
    )
    def qkb_status() -> dict:
        conn = _conn()
        try:
            return Storage(conn).stats()
        finally:
            conn.close()

    return server


def run_server() -> None:
    build_server().run()
