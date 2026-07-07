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
