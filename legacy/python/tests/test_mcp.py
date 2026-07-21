import asyncio
import json
import sqlite3
from unittest.mock import patch

import pytest

from qkb.config import Config
from qkb.db import connect
from qkb.embed.fake import FakeProvider
from qkb.ingest.pipeline import ingest_vault
from qkb.server.mcp import build_server
from tests.test_pipeline import ID1, ID2, write_note


def make_cfg(tmp_path) -> Config:
    vault = tmp_path / "vault"
    vault.mkdir(exist_ok=True)
    cfg = Config()
    cfg.vault_path = vault
    cfg.db_path = tmp_path / "qkb.db"
    cfg.embedding_provider = "fake"
    cfg.embedding_dim = 8
    return cfg


def call(server, name, **kwargs) -> dict:
    """Invoke an MCP tool and return its parsed JSON payload.

    The installed `mcp` SDK's ``call_tool`` returns a list of content parts
    (TextContent) whose ``.text`` is the JSON-serialised return value. Older/
    newer SDKs return a ``(content, structured)`` tuple — the assertions below
    are on payload values, not the envelope shape (per the plan's Task 15 note).
    """
    result = asyncio.run(server.call_tool(name, kwargs))
    content = result[0] if isinstance(result, tuple) else result
    return json.loads(content[0].text)


def test_mcp_tools(tmp_path):
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    server = build_server(cfg)
    tools = asyncio.run(server.list_tools())
    assert {t.name for t in tools} >= {"qkb", "qkb_get", "qkb_status"}

    out = call(server, "qkb", query="traefik")
    assert out["result"][0]["document_id"] == ID1

    out = call(server, "qkb_get", document_id=ID1[:8])
    assert out["document_id"] == ID1

    out = call(server, "qkb_status")
    assert out["documents"] == 1

    out = call(server, "qkb", query="x", rerank=True)
    assert out == {"error": "re-ranking not configured (Phase 2)"}


def test_qkb_uses_cfg_default_limit_when_omitted(tmp_path):
    cfg = make_cfg(tmp_path)
    cfg.default_limit = 1
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    write_note(cfg.vault_path, "b.md", ID2, body="Renewing traefik certificates too.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    server = build_server(cfg)
    out = call(server, "qkb", query="traefik")
    assert len(out["result"]) == cfg.default_limit == 1


def test_qkb_source_filter(tmp_path):
    cfg = make_cfg(tmp_path)
    write_note(
        cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.", extra="source: proj-a\n"
    )
    write_note(
        cfg.vault_path, "b.md", ID2, body="Renewing traefik certificates.", extra="source: proj-b\n"
    )
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    server = build_server(cfg)
    out = call(server, "qkb", query="traefik", source="proj-a")
    assert [r["document_id"] for r in out["result"]] == [ID1]


def test_qkb_limit_below_one_returns_structured_error_not_exception(tmp_path):
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    server = build_server(cfg)
    out = call(server, "qkb", query="traefik", limit=0)
    assert "error" in out
    assert "result" not in out


def test_qkb_context_filter_whitespace_returns_top_level_error(tmp_path):
    """Finding 9: the qkb ValueError branch (here triggered via R4's
    whitespace/empty-context guard in build_filter_clause) must return the
    unified top-level {"error": ...} shape, not {"result": [{"error": ...}]}."""
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    server = build_server(cfg)
    out = call(server, "qkb", query="traefik", context="   ")
    assert out == {"error": "context filter is empty or whitespace-only"}
    assert "result" not in out


def test_qkb_get_missing_raw_file_returns_structured_error(tmp_path):
    cfg = make_cfg(tmp_path)
    note_path = write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()
    note_path.unlink()

    server = build_server(cfg)
    out = call(server, "qkb_get", document_id=ID1[:8], include_raw=True)
    assert "error" in out and "qkb ingest" in out["error"].lower()


def test_provider_constructed_once_and_reused_across_calls(tmp_path):
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    with patch(
        "qkb.server.mcp.get_provider", side_effect=lambda c: FakeProvider(c.embedding_dim)
    ) as spy:
        server = build_server(cfg)
        assert spy.call_count == 1
        call(server, "qkb", query="traefik")
        call(server, "qkb", query="traefik")
        assert spy.call_count == 1  # built once in build_server, reused for every tool call


def test_lifespan_closes_provider_and_connection(tmp_path):
    """Review finding 3 (mcp.py): the lifespan teardown must close both the
    shared embedding provider and the shared sqlite connection built once in
    build_server - not per tool call. Drives FastMCP's lifespan context
    manager directly (via the low-level Server it wraps) since there's no
    higher-level test hook for it."""
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    closed = {"provider": False}

    class ClosingFakeProvider(FakeProvider):
        def close(self) -> None:
            closed["provider"] = True

    captured: dict[str, sqlite3.Connection] = {}

    def spy_connect(*args, **kwargs):
        c = connect(*args, **kwargs)
        captured["conn"] = c
        return c

    with (
        patch(
            "qkb.server.mcp.get_provider",
            side_effect=lambda c: ClosingFakeProvider(c.embedding_dim),
        ),
        patch("qkb.server.mcp.connect", side_effect=spy_connect),
    ):
        server = build_server(cfg)

        async def _drive_lifespan() -> None:
            async with server._mcp_server.lifespan(server._mcp_server):
                pass

        asyncio.run(_drive_lifespan())

    assert closed["provider"] is True
    with pytest.raises(sqlite3.ProgrammingError):
        captured["conn"].execute("SELECT 1")


def test_connection_built_once_no_per_call_bootstrap(tmp_path):
    cfg = make_cfg(tmp_path)
    write_note(cfg.vault_path, "a.md", ID1, body="Renewing traefik certificates.")
    conn = connect(cfg.db_path, cfg.embedding_dim)
    ingest_vault(conn, cfg, FakeProvider(8))
    conn.close()

    with patch("qkb.server.mcp.connect", wraps=connect) as spy:
        server = build_server(cfg)
        assert spy.call_count == 1
        call(server, "qkb", query="traefik")
        call(server, "qkb_get", document_id=ID1[:8])
        call(server, "qkb_status")
        assert spy.call_count == 1  # one connection, shared by qkb/qkb_get/qkb_status
