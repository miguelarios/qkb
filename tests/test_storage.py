import pytest

from qkb.ingest.storage import Storage, content_hash
from tests.conftest import ingest_one, make_note


def test_upsert_writes_all_tables(conn, provider):
    note = make_note()
    ingest_one(conn, provider, note)
    assert conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM documents_fts").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"] >= 1
    assert conn.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"] >= 1
    assert {r["tag"] for r in conn.execute("SELECT tag FROM tags")} == {"networking", "ssl"}
    row = conn.execute("SELECT value FROM metadata WHERE key='status'").fetchone()
    assert row["value"] == "resolved"


def test_reupsert_replaces_not_duplicates(conn, provider):
    note = make_note()
    ingest_one(conn, provider, note)
    ingest_one(conn, provider, make_note(body="# Traefik\n\nCompletely new body."))
    assert conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM documents_fts").fetchone()["c"] == 1
    orphans = conn.execute(
        "SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id NOT IN (SELECT id FROM chunks)"
    ).fetchone()["c"]
    assert orphans == 0


def test_delete_removes_everything(conn, provider):
    note = make_note()
    ingest_one(conn, provider, note)
    Storage(conn).delete(note.id)
    for table in ["documents", "documents_fts", "chunks", "chunks_vec", "tags", "metadata"]:
        assert conn.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"] == 0, table


def test_content_hash_roundtrip(conn, provider):
    note = make_note()
    s = Storage(conn)
    assert s.get_content_hash(note.id) is None
    ingest_one(conn, provider, note)
    assert s.get_content_hash(note.id) == content_hash(note.body)


def test_embedding_config_check(conn):
    s = Storage(conn)
    assert s.check_embedding_config("fake-8d", 8) is True  # first call records
    assert s.check_embedding_config("fake-8d", 8) is True  # same -> ok
    assert s.check_embedding_config("other-model", 8) is False


def test_update_metadata_if_changed_is_noop_when_nothing_changed(conn, provider):
    """Finding 10: when neither the body nor the frontmatter-derived metadata
    changed, update_metadata_if_changed must perform ZERO writes (no documents/
    FTS/tags/metadata rewrite, no indexed_at bump) and report no change."""
    note = make_note()
    ingest_one(conn, provider, note)
    s = Storage(conn)
    before_changes = conn.total_changes
    before_indexed_at = conn.execute(
        "SELECT indexed_at FROM documents WHERE id = ?", (note.id,)
    ).fetchone()["indexed_at"]

    changed = s.update_metadata_if_changed(note, content_hash(note.body))

    assert changed is False
    assert conn.total_changes == before_changes
    after_indexed_at = conn.execute(
        "SELECT indexed_at FROM documents WHERE id = ?", (note.id,)
    ).fetchone()["indexed_at"]
    assert after_indexed_at == before_indexed_at


def test_update_metadata_if_changed_writes_when_metadata_changed(conn, provider):
    """Body-unchanged but frontmatter-derived metadata changed (title/tags here)
    must still be written - this is the one legitimate reason
    update_metadata_if_changed exists."""
    note = make_note()
    ingest_one(conn, provider, note)
    s = Storage(conn)
    before_changes = conn.total_changes
    updated = make_note(
        title="Traefik Cert Renewal (updated)", tags=["networking", "ssl", "renewed"]
    )

    changed = s.update_metadata_if_changed(updated, content_hash(updated.body))

    assert changed is True
    assert conn.total_changes > before_changes
    row = conn.execute("SELECT title FROM documents WHERE id = ?", (note.id,)).fetchone()
    assert row["title"] == "Traefik Cert Renewal (updated)"
    tags = {
        r["tag"] for r in conn.execute("SELECT tag FROM tags WHERE document_id = ?", (note.id,))
    }
    assert tags == {"networking", "ssl", "renewed"}
    fts_title = conn.execute(
        "SELECT title FROM documents_fts WHERE doc_id = ?", (note.id,)
    ).fetchone()["title"]
    assert fts_title == "Traefik Cert Renewal (updated)"


def test_metadata_hash_distinguishes_ambiguous_tag_splits():
    """Delimiter discipline: a tag list of ["a,b"] must not hash the same as
    ["a", "b"] - otherwise a genuine tag-list edit is silently missed."""
    from qkb.ingest.storage import metadata_hash

    one = make_note(tags=["a,b"])
    two = make_note(tags=["a", "b"])
    assert metadata_hash(one) != metadata_hash(two)


def test_metadata_hash_distinguishes_ambiguous_extra_metadata_splits():
    """Same discipline for extra_metadata key=value pairs joined together.

    {"a": "b,c=d"} and {"a": "b", "c": "d"} are a genuinely-colliding pair
    under a naive comma/equals join ("a=b,c=d" either way - asserted below)
    - so this test would FAIL if metadata_hash regressed to that naive
    scheme. The real implementation uses distinct US/RS/GS control-char
    separators instead of "," and "=", so it must still tell them apart.
    """
    from qkb.ingest.storage import metadata_hash

    one = make_note(extra_metadata={"a": "b,c=d"})
    two = make_note(extra_metadata={"a": "b", "c": "d"})
    assert metadata_hash(one) != metadata_hash(two)

    # Sanity check on the premise: confirm these two truly collide under a
    # naive comma/equals join, so the assertion above is a real regression
    # guard and not just two arbitrary distinct dicts.
    naive_one = ",".join(f"{k}={v}" for k, v in sorted(one.extra_metadata.items()))
    naive_two = ",".join(f"{k}={v}" for k, v in sorted(two.extra_metadata.items()))
    assert naive_one == naive_two


def test_update_metadata_if_changed_applies_ambiguous_tag_edit(conn, provider):
    """End-to-end: editing tags from ["a", "b"] to ["a,b"] (a real change that a
    naive comma-join would mask) must be detected and written."""
    note = make_note(tags=["a", "b"])
    ingest_one(conn, provider, note)
    s = Storage(conn)
    edited = make_note(tags=["a,b"])

    changed = s.update_metadata_if_changed(edited, content_hash(edited.body))

    assert changed is True
    tags = {
        r["tag"] for r in conn.execute("SELECT tag FROM tags WHERE document_id = ?", (note.id,))
    }
    assert tags == {"a,b"}


def test_upsert_filters_reserved_metadata_key_directly(conn, provider):
    """Independent of the parser: even if a ParsedNote's extra_metadata somehow
    contains the reserved __qkb_meta_hash__ key (bypassing the parser's own
    strip - see test_pipeline.test_reserved_metadata_key_in_frontmatter_does_not_crash
    for that path), Storage.upsert's own `if k != _METADATA_HASH_KEY` filter
    must independently prevent the IntegrityError this would otherwise cause
    (both rows sharing the (document_id, key) primary key), and the stored
    hash row must hold the real computed metadata_hash - not the injected
    value."""
    from qkb.ingest.storage import _METADATA_HASH_KEY, metadata_hash

    note = make_note(extra_metadata={_METADATA_HASH_KEY: "injected-fake-hash"})
    ingest_one(conn, provider, note)  # must not raise IntegrityError

    stored = conn.execute(
        "SELECT value FROM metadata WHERE document_id = ? AND key = ?",
        (note.id, _METADATA_HASH_KEY),
    ).fetchone()["value"]
    assert stored == metadata_hash(note)
    assert stored != "injected-fake-hash"


def test_clear_content_hash_forces_reembed_path(conn, provider):
    """R1.2: clear_content_hash blanks documents.content_hash so the next
    ingest of this doc can never take the hash-unchanged fast path (finding 1:
    a --full that wiped chunks_vec must force protected, unre-embedded docs
    back through the full upsert path)."""
    note = make_note()
    ingest_one(conn, provider, note)
    s = Storage(conn)
    assert s.get_content_hash(note.id) == content_hash(note.body)

    s.clear_content_hash(note.id)

    assert s.get_content_hash(note.id) == ""


def test_context_descriptions_and_stats(conn, provider):
    ingest_one(conn, provider, make_note())
    s = Storage(conn)
    s.set_context_description("homelab-traefik", "Reverse proxy and cert notes")
    rows = s.list_contexts()
    assert rows == [
        {"context": "homelab-traefik", "count": 1, "description": "Reverse proxy and cert notes"}
    ]
    s.set_context_description("homelab-traefik", None)
    assert s.list_contexts()[0]["description"] is None
    st = s.stats()
    assert st["documents"] == 1 and st["chunks"] >= 1


def test_set_context_description_normalizes_context(conn, provider):
    """6e: Storage.set_context_description must normalize the label itself
    (mirroring parser.normalize_context), not rely solely on the CLI having
    already done it - so a future non-CLI caller can't store a description
    under a context ingest/query-normalized contexts never match."""
    ingest_one(conn, provider, make_note(context="homelab"))
    s = Storage(conn)

    s.set_context_description("  Homelab  ", "x")

    row = conn.execute(
        "SELECT description FROM context_descriptions WHERE context = ?", ("homelab",)
    ).fetchone()
    assert row["description"] == "x"
    assert (
        conn.execute(
            "SELECT COUNT(*) c FROM context_descriptions WHERE context = ?", ("  Homelab  ",)
        ).fetchone()["c"]
        == 0
    )


def test_set_context_description_rejects_empty_after_normalization(conn):
    s = Storage(conn)
    with pytest.raises(ValueError):
        s.set_context_description("   ", "x")


def test_all_metadata_hashes_returns_stored_hashes(conn, provider):
    """6b: Storage.all_metadata_hashes() batches what update_metadata_if_changed
    otherwise looks up per-document via get_metadata_hash."""
    from qkb.ingest.storage import metadata_hash

    note = make_note()
    ingest_one(conn, provider, note)
    s = Storage(conn)

    hashes = s.all_metadata_hashes()

    assert hashes == {note.id: metadata_hash(note, s.vault_name)}
    assert hashes[note.id] == s.get_metadata_hash(note.id)


def test_update_metadata_if_changed_uses_precomputed_hash_without_select(conn, provider):
    """6b: when the caller supplies stored_metadata_hash (as the pipeline now
    does, from the batched all_metadata_hashes() dict), update_metadata_if_changed
    must not run its own get_metadata_hash SELECT - and no-op semantics must be
    identical to the unsupplied-argument path."""
    from unittest.mock import patch

    note = make_note()
    ingest_one(conn, provider, note)
    s = Storage(conn)
    meta_hashes = s.all_metadata_hashes()
    before_changes = conn.total_changes

    with patch.object(Storage, "get_metadata_hash") as spy:
        changed = s.update_metadata_if_changed(
            note, content_hash(note.body), meta_hashes.get(note.id)
        )

    spy.assert_not_called()
    assert changed is False
    assert conn.total_changes == before_changes
