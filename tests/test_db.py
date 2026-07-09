import sqlite3

import pytest

from qkb.db import connect, rebuild_vector_table, vector_table_dimension


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


def test_rebuild_vector_table_changes_dimension(tmp_path):
    import sqlite_vec

    conn = connect(tmp_path / "qkb.db", embedding_dim=4)
    rebuild_vector_table(conn, 8)
    # a 4-dim insert must now fail; an 8-dim insert must succeed and be searchable
    with pytest.raises(sqlite3.Error):
        conn.execute(
            "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
            (1, sqlite_vec.serialize_float32([0.1, 0.2, 0.3, 0.4])),
        )
    conn.execute(
        "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
        (2, sqlite_vec.serialize_float32([0.1] * 8)),
    )
    row = conn.execute(
        "SELECT chunk_id FROM chunks_vec WHERE embedding MATCH ? AND k = 1",
        (sqlite_vec.serialize_float32([0.1] * 8),),
    ).fetchone()
    assert row["chunk_id"] == 2


def test_vector_table_dimension_reads_created_dimension(tmp_path):
    conn = connect(tmp_path / "qkb.db", embedding_dim=8)
    assert vector_table_dimension(conn) == 8

    rebuild_vector_table(conn, 16)
    assert vector_table_dimension(conn) == 16


def test_vector_table_dimension_none_when_table_missing(tmp_path):
    conn = connect(tmp_path / "qkb.db", embedding_dim=8)
    conn.execute("DROP TABLE chunks_vec")
    assert vector_table_dimension(conn) is None
