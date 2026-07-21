import pytest

from qkb.db import connect
from qkb.embed.fake import FakeProvider
from qkb.ingest.chunker import chunk_text
from qkb.models import ParsedNote

DIM = 8


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "qkb.db", embedding_dim=DIM)
    yield c
    c.close()


@pytest.fixture
def provider():
    return FakeProvider(dimension=DIM)


def make_note(**overrides) -> ParsedNote:
    base = dict(
        id="f47ac10b-58cc-4372-a567-0e02b2c3d401",
        type="note",
        title="Traefik Cert Renewal",
        context="homelab-traefik",
        source=None,
        effective_date="2026-03-15",
        created_at="2026-03-15T10:00:00-06:00",
        tags=["networking", "ssl"],
        extra_metadata={"status": "resolved"},
        body="# Traefik\n\nRenewing certificates requires restarting the proxy container.",
        file_path="02-Areas/Homelab/Traefik Cert Renewal.md",
    )
    base.update(overrides)
    return ParsedNote(**base)


def ingest_one(conn, provider, note: ParsedNote):
    """Chunk + embed + upsert a note (test helper mirroring the pipeline)."""
    from qkb.ingest.storage import Storage, content_hash

    chunks = chunk_text(note.body)
    embeddings = provider.embed([c.text for c in chunks])
    Storage(conn).upsert(note, content_hash(note.body), chunks, embeddings)
