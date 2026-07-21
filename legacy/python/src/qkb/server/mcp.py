"""MCP stdio server exposing qkb search to LLM agents (DESIGN.md §9.2)."""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from mcp.server.fastmcp import FastMCP

from qkb.config import Config, load_config
from qkb.db import connect
from qkb.embed import get_provider
from qkb.ingest.storage import Storage
from qkb.search.filters import Filters
from qkb.search.retrieval import DocumentFileMissing, get_document
from qkb.search.service import execute_search


def build_server(cfg: Config | None = None) -> FastMCP:
    cfg = cfg or load_config()

    # Review finding 9: the previous implementation built a fresh
    # OllamaProvider (and thus a fresh keep-alive httpx.Client, never closed)
    # and re-opened SQLite (full DDL executescript + sqlite-vec extension
    # load) on *every* tool call. The server is long-lived, so build the
    # connection and the embedding provider once here and let every tool call
    # below share them.
    #
    # Sharing them safely currently rests on every tool body below being a
    # SYNCHRONOUS function (`def`, no `await`): FastMCP awaits each tool call
    # to completion before the event loop can start the next one, so two
    # synchronous tool bodies can never interleave their statements against
    # `conn`/`provider`, even under concurrent requests.
    #
    # Below-the-cut: that safety was previously just a comment ("every tool
    # body must stay sync") - a convention, not a mechanism. `_lock` below
    # turns it into one: each tool body's conn/provider-touching region runs
    # `with _lock:`, so calls serialize on the shared connection even if a
    # future change makes a body async or FastMCP ever dispatches tool calls
    # on separate threads. Uncontended (and therefore cheap) as long as
    # bodies stay synchronous, which they still must.
    conn = connect(cfg.db_path, cfg.embedding_dim)
    provider = get_provider(cfg)
    _lock = threading.Lock()

    @asynccontextmanager
    async def _lifespan(_server: FastMCP) -> AsyncIterator[None]:
        try:
            yield
        finally:
            # Duck-typed close: OllamaProvider defines close() (closes its
            # httpx.Client); FakeProvider (used only in offline tests) has no
            # resources to release, so the EmbeddingProvider Protocol is left
            # without a `close` member rather than forcing a no-op onto it.
            close = getattr(provider, "close", None)
            if close is not None:
                close()
            conn.close()

    server = FastMCP("qkb", lifespan=_lifespan)

    @server.tool(
        name="qkb",
        description=(
            "Search the personal knowledge base (Obsidian vault) with hybrid "
            "BM25 + vector retrieval. Filter by context, source, type, tags, or "
            "date range. Results include sibling documents and context "
            "descriptions."
        ),
    )
    def qkb(
        query: str,
        context: str | None = None,
        source: str | None = None,
        type: str | None = None,  # noqa: A002 - MCP param name per spec
        tags: list[str] | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        limit: int | None = None,
        rerank: bool = False,
    ) -> dict:
        if rerank:
            return {"error": "re-ranking not configured (Phase 2)"}
        with _lock:
            try:
                results = execute_search(
                    conn,
                    cfg,
                    provider,
                    query,
                    Filters(
                        context=context,
                        source=source,
                        doc_type=type,
                        tags=tags,
                        date_from=date_from,
                        date_to=date_to,
                    ),
                    limit,
                    "hybrid",
                )
            except ValueError as e:
                return {"error": str(e)}
        return {"result": results}

    @server.tool(
        name="qkb_get",
        description="Retrieve a document by UUID (full or prefix): metadata, file path, "
        "obsidian:// URI, siblings, and optionally the raw markdown body.",
    )
    def qkb_get(document_id: str, include_raw: bool = False, include_siblings: bool = True) -> dict:
        with _lock:
            try:
                return get_document(
                    conn,
                    document_id,
                    vault_path=cfg.vault_path,
                    include_raw=include_raw,
                    include_siblings=include_siblings,
                )
            # get_document raises DocumentFileMissing when the on-disk file is
            # gone since the last ingest. An MCP tool should hand the caller a
            # structured error to reason about, not an uncaught exception.
            # DocumentFileMissing subclasses FileNotFoundError (not KeyError/
            # ValueError), so it must stay named in the tuple to be caught
            # here; its arm was byte-identical to the one below, so they're
            # merged (below-the-cut).
            except (DocumentFileMissing, KeyError, ValueError) as e:
                return {"error": str(e)}

    @server.tool(
        name="qkb_status",
        description="Index health: document/chunk counts, context list with "
        "descriptions, last ingestion time.",
    )
    def qkb_status() -> dict:
        with _lock:
            return Storage(conn).stats()

    return server


def run_server() -> None:
    build_server().run()
