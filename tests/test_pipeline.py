import logging

import pytest

from qkb.config import Config
from qkb.embed.fake import FakeProvider
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


def test_full_reembed_across_dimension_change_rebuilds_vector_index(conn, provider, cfg, vault):
    """Finding 1: switching to a wider embedding dimension and running --full must
    rebuild chunks_vec instead of crashing on the first mismatched-dimension insert."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # indexed at dim=8

    wider = FakeProvider(dimension=16)
    stats = ingest_vault(conn, cfg, wider, full=True)  # must not raise sqlite-vec dim mismatch
    assert stats.indexed == 2

    chunk_count = conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
    vec_count = conn.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"]
    assert chunk_count > 0
    assert vec_count == chunk_count

    import sqlite_vec

    qvec = wider.embed_query("Another note body")
    row = conn.execute(
        "SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1",
        (sqlite_vec.serialize_float32(qvec),),
    ).fetchone()
    assert row is not None


class _ExplodingProvider(FakeProvider):
    """FakeProvider under a different model name that fails after N embed() calls,
    simulating an Ollama crash / Ctrl-C partway through a --full re-embed."""

    def __init__(self, dimension: int, model_name: str, fail_after: int):
        super().__init__(dimension=dimension)
        self._model_name_override = model_name
        self._fail_after = fail_after
        self._calls = 0

    @property
    def model_name(self) -> str:
        return self._model_name_override

    def embed(self, texts: list[str]) -> list[list[float]]:
        self._calls += 1
        if self._calls > self._fail_after:
            raise RuntimeError("simulated interruption")
        return super().embed(texts)


def test_parse_exception_on_present_file_does_not_deindex(conn, provider, cfg, vault, caplog):
    """Finding 2: a note that fails to parse (exception) this run, but whose file
    is still present in the vault, must keep its prior index entry - only a
    genuinely-deleted file should be de-indexed."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "b.md", ID2)
    ingest_vault(conn, cfg, provider)

    # a.md gets a mid-edit save with malformed YAML frontmatter (parse raises)
    (vault / "a.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")
    # b.md is genuinely deleted
    (vault / "b.md").unlink()

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.deindexed == 1  # only the genuinely-deleted b.md
    assert stats.skipped >= 1  # a.md's parse failure is counted, not silently dropped

    # a.md's prior rows are still intact and searchable
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?", (ID1,)).fetchone()[
            "c"
        ]
        == 1
    )
    # b.md is fully gone
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID2,)).fetchone()["c"] == 0
    )


def test_duplicate_frontmatter_id_skips_second_and_no_ping_pong(conn, provider, cfg, vault, caplog):
    """Finding 4: two files sharing the same frontmatter id must not silently
    overwrite each other - the first (sorted) file wins, the duplicate is
    warned about and counted, and re-ingesting must not ping-pong re-embed."""
    write_note(vault, "a.md", ID1, body="First body.")
    write_note(vault, "z-dup.md", ID1, body="Second body claiming the same id.")

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.indexed == 1  # only the first (sorted) file was indexed
    assert stats.skipped >= 1  # the duplicate is counted, not silently absorbed
    assert any("duplicate" in r.message.lower() for r in caplog.records)

    row = conn.execute("SELECT file_path FROM documents WHERE id = ?", (ID1,)).fetchone()
    assert row["file_path"] == "a.md"

    # a second consecutive ingest must not re-embed either file (no ping-pong)
    stats2 = ingest_vault(conn, cfg, provider)
    assert stats2.indexed == 0
    assert stats2.updated == 0
    assert stats2.unchanged == 1
    assert stats2.skipped >= 1


def test_interrupted_full_reembed_does_not_commit_new_model(conn, provider, cfg, vault):
    """Finding 3: an interrupted --full (fails partway through the document loop) must
    NOT commit the new model into embedding_config — the guard must still fire on the
    next plain ingest, forcing the user to re-run --full."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # committed as fake-8d

    model_b = _ExplodingProvider(dimension=8, model_name="model-b", fail_after=1)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        ingest_vault(conn, cfg, model_b, full=True)

    # the interrupted full run must not have committed model-b as current
    with pytest.raises(RuntimeError, match="--full"):
        ingest_vault(conn, cfg, model_b, full=False)
