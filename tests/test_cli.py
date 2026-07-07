import json

from click.testing import CliRunner

from qkb.cli import cli
from tests.test_pipeline import ID1, write_note


def run(args, env):
    return CliRunner().invoke(cli, args, env=env, catch_exceptions=False)


def make_env(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir(exist_ok=True)
    return vault, {
        "QKB_VAULT_PATH": str(vault),
        "QKB_DB_PATH": str(tmp_path / "qkb.db"),
        "QKB_EMBEDDING_PROVIDER": "fake",
        "QKB_EMBEDDING_DIM": "8",
        "QKB_CONFIG": str(tmp_path / "missing.toml"),
    }


def test_ingest_then_query_json(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1, body="Renewing traefik certificates.")
    r = run(["ingest"], env)
    assert r.exit_code == 0 and "indexed" in r.output.lower()

    r = run(["query", "traefik", "--json"], env)
    assert r.exit_code == 0
    results = json.loads(r.output)
    assert results[0]["document_id"] == ID1
    assert "obsidian_uri" in results[0]


def test_search_files_format_and_filters(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1, body="Renewing traefik certificates.")
    run(["ingest"], env)
    r = run(["search", "traefik", "--files", "--context", "homelab"], env)
    assert r.exit_code == 0
    assert r.output.strip().split(",")[0] == ID1
    r = run(["search", "traefik", "--files", "--context", "nonexistent"], env)
    assert r.output.strip() == ""


def test_get_and_contexts_and_status(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1)
    run(["ingest"], env)
    r = run(["get", ID1[:8], "--json"], env)
    assert json.loads(r.output)["document_id"] == ID1

    r = run(["context", "describe", "homelab", "Home server notes"], env)
    assert r.exit_code == 0
    r = run(["contexts", "--json"], env)
    rows = json.loads(r.output)
    assert rows[0]["context"] == "homelab" and rows[0]["description"] == "Home server notes"

    r = run(["status", "--json"], env)
    assert json.loads(r.output)["documents"] == 1


def test_rerank_not_configured(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1)
    run(["ingest"], env)
    r = run(["query", "anything", "--rerank"], env)
    assert r.exit_code == 2
