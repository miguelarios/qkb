import json

from click.testing import CliRunner

from qkb.cli import cli
from tests.test_pipeline import ID1, ID2, write_note


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
    # `get` and `status` always emit JSON now; the dead `--json` flag was removed.
    r = run(["get", ID1[:8]], env)
    assert json.loads(r.output)["document_id"] == ID1

    r = run(["context", "describe", "homelab", "Home server notes"], env)
    assert r.exit_code == 0
    r = run(["contexts", "--json"], env)
    rows = json.loads(r.output)
    assert rows[0]["context"] == "homelab" and rows[0]["description"] == "Home server notes"

    r = run(["status", "--json"], env)
    assert json.loads(r.output)["documents"] == 1
    r = run(["status"], env)  # human-readable default
    assert r.exit_code == 0 and "Provider:" in r.output and "fake" in r.output


def test_context_describe_normalizes_label(tmp_path):
    """8a: `context describe` must normalize the label through the same
    normalize_context() used everywhere else, not a hand-rolled strip().lower()."""
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1)
    run(["ingest"], env)

    r = run(["context", "describe", "  Homelab  ", "Home server notes"], env)
    assert r.exit_code == 0
    r = run(["contexts", "--json"], env)
    rows = json.loads(r.output)
    assert rows[0]["context"] == "homelab" and rows[0]["description"] == "Home server notes"


def test_context_describe_empty_label_errors(tmp_path):
    vault, env = make_env(tmp_path)
    r = run(["context", "describe", "   ", "desc"], env)
    assert r.exit_code != 0


def test_get_rejects_removed_json_flag_but_status_accepts_it(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1)
    run(["ingest"], env)
    r = run(["get", ID1[:8], "--json"], env)
    assert r.exit_code != 0 and "no such option" in r.output.lower()
    # status is human-readable by default now, and regained --json for machines.
    r = run(["status", "--json"], env)
    assert r.exit_code == 0 and json.loads(r.output)["documents"] == 1


def test_rerank_not_configured(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1)
    run(["ingest"], env)
    r = run(["query", "anything", "--rerank"], env)
    assert r.exit_code == 2


def test_source_filter(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1, body="Renewing traefik certificates.", extra="source: proj-a\n")
    write_note(vault, "b.md", ID2, body="Renewing traefik certificates.", extra="source: proj-b\n")
    run(["ingest"], env)

    r = run(["search", "traefik", "--files", "--source", "proj-a"], env)
    assert r.exit_code == 0
    lines = [line for line in r.output.strip().splitlines() if line]
    assert len(lines) == 1 and lines[0].split(",")[0] == ID1

    r = run(["search", "traefik", "--files", "--source", "nonexistent"], env)
    assert r.output.strip() == ""


def test_limit_zero_and_negative_rejected(tmp_path):
    vault, env = make_env(tmp_path)
    write_note(vault, "a.md", ID1, body="Renewing traefik certificates.")
    run(["ingest"], env)

    r = run(["search", "traefik", "--limit", "0"], env)
    assert r.exit_code != 0
    assert "traceback" not in r.output.lower()

    r = run(["search", "traefik", "--limit", "-1"], env)
    assert r.exit_code != 0
    assert "traceback" not in r.output.lower()


def test_default_limit_applied_when_limit_omitted(tmp_path):
    vault, env = make_env(tmp_path)
    env = dict(env)
    (vault.parent / "config.toml").write_text("[search]\ndefault_limit = 1\n")
    env["QKB_CONFIG"] = str(vault.parent / "config.toml")
    write_note(vault, "a.md", ID1, body="Renewing traefik certificates.")
    write_note(vault, "b.md", ID2, body="Renewing traefik certificates too.")
    run(["ingest"], env)

    r = run(["search", "traefik", "--json"], env)
    assert r.exit_code == 0
    assert len(json.loads(r.output)) == 1


def test_get_raw_missing_file_clean_error(tmp_path):
    vault, env = make_env(tmp_path)
    note_path = write_note(vault, "a.md", ID1, body="Renewing traefik certificates.")
    run(["ingest"], env)
    note_path.unlink()

    r = run(["get", ID1[:8], "--raw"], env)
    assert r.exit_code != 0
    assert "traceback" not in r.output.lower()
    assert "qkb ingest" in r.output.lower()
