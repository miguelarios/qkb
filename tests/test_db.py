from qkb.db import connect


def test_schema_created(tmp_path):
    conn = connect(tmp_path / "sub" / "qkb.db", embedding_dim=8)
    names = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    }
    for t in [
        "documents",
        "documents_fts",
        "chunks",
        "chunks_vec",
        "tags",
        "metadata",
        "context_descriptions",
        "embedding_config",
    ]:
        assert t in names, t


def test_connect_idempotent(tmp_path):
    p = tmp_path / "qkb.db"
    connect(p, 8).close()
    conn = connect(p, 8)  # second connect must not fail on existing DDL
    conn.execute("SELECT 1")


def test_vector_roundtrip(tmp_path):
    import sqlite_vec

    conn = connect(tmp_path / "qkb.db", embedding_dim=4)
    conn.execute(
        "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
        (1, sqlite_vec.serialize_float32([0.1, 0.2, 0.3, 0.4])),
    )
    row = conn.execute(
        "SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1",
        (sqlite_vec.serialize_float32([0.1, 0.2, 0.3, 0.4]),),
    ).fetchone()
    assert row["chunk_id"] == 1
