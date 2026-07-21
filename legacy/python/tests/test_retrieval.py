import pytest

from qkb.search.retrieval import DocumentFileMissing, get_document
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


def test_get_raw_missing_file_raises_typed_error(conn, provider, tmp_path):
    """Finding 8: a note moved/renamed since ingest must raise a typed,
    catchable error (not a bare traceback)."""
    vault = tmp_path / "vault"
    vault.mkdir()
    ingest_one(conn, provider, make_note(id=ID_A))  # file_path never written to vault

    with pytest.raises(DocumentFileMissing) as exc_info:
        get_document(conn, "aaaaaaaa", vault_path=vault, include_raw=True)

    message = str(exc_info.value)
    assert "re-ingest" in message.lower() or "ingest" in message.lower()
    assert "moved" in message.lower() or "deleted" in message.lower()
    # Must still be catchable by callers that only know about FileNotFoundError.
    assert isinstance(exc_info.value, FileNotFoundError)


def test_get_raw_reads_utf8_non_ascii(conn, provider, tmp_path):
    """Finding 8: read_text must use an explicit utf-8 encoding, not the
    locale default, so non-ASCII content round-trips correctly."""
    vault = tmp_path / "vault"
    note_path = vault / "02-Areas/Homelab/Traefik Cert Renewal.md"
    note_path.parent.mkdir(parents=True)
    non_ascii_body = "# Café notes — café, ümläut, \U0001f600\n"
    note_path.write_text(non_ascii_body, encoding="utf-8")
    ingest_one(conn, provider, make_note(id=ID_A))

    doc = get_document(conn, "aaaaaaaa", vault_path=vault, include_raw=True)
    assert non_ascii_body in doc["raw_text"]


def test_get_raw_file_path_is_directory_raises_typed_error(conn, provider, tmp_path):
    """Below-the-cut: only FileNotFoundError was caught around read_text, so
    PermissionError/IsADirectoryError still tracebacked raw. Making the raw
    path a directory (portable across platforms, unlike chmod 000) reproduces
    an OSError subclass other than FileNotFoundError and must still raise
    DocumentFileMissing, not a bare OSError."""
    vault = tmp_path / "vault"
    note_path = vault / "02-Areas/Homelab/Traefik Cert Renewal.md"
    note_path.mkdir(parents=True)  # a directory sits where the file should be
    ingest_one(conn, provider, make_note(id=ID_A))

    with pytest.raises(DocumentFileMissing) as exc_info:
        get_document(conn, "aaaaaaaa", vault_path=vault, include_raw=True)

    # A directory raises IsADirectoryError, not FileNotFoundError - this must
    # hit the broader `except OSError` arm (its distinct "cannot read" message),
    # not the "moved or deleted" one, and still not a bare OSError/traceback.
    message = str(exc_info.value)
    assert "cannot read" in message.lower()


def test_get_percent_prefix_does_not_match_all(conn, provider):
    """Below-the-cut: an unescaped LIKE prefix would let '%' match every
    document instead of raising KeyError for a nonexistent id."""
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
        get_document(conn, "%")


def test_get_underscore_prefix_does_not_wildcard_match(conn, provider):
    """A literal '_' in the prefix must match only a literal underscore,
    not "any single character"."""
    ingest_one(conn, provider, make_note(id=ID_A))

    with pytest.raises(KeyError):
        get_document(conn, "_aaaaaaa")
