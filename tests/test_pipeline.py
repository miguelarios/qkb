import pytest

from qkb.config import Config
from qkb.ingest.pipeline import ingest_vault


def write_note(vault, name, note_id, context="homelab", body="Some body text.", extra=""):
    p = vault / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        f"---\nid: {note_id}\ncontext: {context}\n"
        f"created: 2026-01-01T00:00:00-06:00\n{extra}---\n\n{body}\n"
    )
    return p


@pytest.fixture
def vault(tmp_path):
    v = tmp_path / "vault"
    v.mkdir()
    (v / ".obsidian").mkdir()
    (v / ".obsidian" / "ignore-me.md").write_text("no frontmatter")
    return v


@pytest.fixture
def cfg(vault, tmp_path):
    c = Config()
    c.vault_path = vault
    c.db_path = tmp_path / "qkb.db"
    c.embedding_provider = "fake"
    c.embedding_dim = 8
    return c


ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401"
ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402"


def test_ingest_new_and_unchanged_and_updated(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    stats = ingest_vault(conn, cfg, provider)
    assert stats.indexed == 2 and stats.scanned >= 2

    stats = ingest_vault(conn, cfg, provider)  # no changes
    assert stats.unchanged == 2 and stats.indexed == 0

    write_note(vault, "a.md", ID1, body="Edited body!")  # content change
    stats = ingest_vault(conn, cfg, provider)
    assert stats.updated == 1 and stats.unchanged == 1


def test_optout_and_file_deletion_deindex(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    write_note(vault, "b.md", ID2)
    ingest_vault(conn, cfg, provider)

    # opt out: rewrite without context/source
    (vault / "a.md").write_text(f"---\nid: {ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nx\n")
    # deletion: remove b.md entirely
    (vault / "b.md").unlink()
    stats = ingest_vault(conn, cfg, provider)
    assert stats.deindexed == 2
    assert conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"] == 0


def test_model_switch_requires_full(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)
    from qkb.embed.fake import FakeProvider

    other = FakeProvider(dimension=8)
    other_name = "different-model"
    other.__class__ = type("P", (FakeProvider,), {"model_name": property(lambda s: other_name)})
    with pytest.raises(RuntimeError, match="--full"):
        ingest_vault(conn, cfg, other)
    stats = ingest_vault(conn, cfg, other, full=True)
    assert stats.indexed == 1
