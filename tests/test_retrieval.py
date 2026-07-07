import pytest

from qkb.search.retrieval import get_document
from tests.conftest import ingest_one, make_note

ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def test_get_by_prefix_and_raw(conn, provider, tmp_path):
    vault = tmp_path / "vault"
    note_path = vault / "02-Areas/Homelab/Traefik Cert Renewal.md"
    note_path.parent.mkdir(parents=True)
    note_path.write_text("---\nid: x\n---\n\nThe body on disk.\n")
    ingest_one(conn, provider, make_note(id=ID_A))

    doc = get_document(conn, "aaaaaaaa", vault_path=vault, include_raw=True)
    assert doc["document_id"] == ID_A
    assert "The body on disk." in doc["raw_text"]


def test_get_missing_and_ambiguous(conn, provider):
    ingest_one(conn, provider, make_note(id=ID_A))
    ingest_one(
        conn,
        provider,
        make_note(
            id="aaaaaaaa-ffff-4fff-8fff-ffffffffffff",
            file_path="other.md",
            context="personal",
        ),
    )
    with pytest.raises(KeyError):
        get_document(conn, "zzzz")
    with pytest.raises(ValueError):
        get_document(conn, "aaaaaaaa")
