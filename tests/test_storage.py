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
    """Same discipline for extra_metadata key=value pairs joined together."""
    from qkb.ingest.storage import metadata_hash

    one = make_note(extra_metadata={"k": "a,b"})
    two = make_note(extra_metadata={"k": "a", "b": ""})
    assert metadata_hash(one) != metadata_hash(two)


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
