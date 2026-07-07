from qkb.search.filters import Filters
from qkb.search.vector import search_vector
from tests.conftest import ingest_one, make_note

ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def seed(conn, provider):
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_A,
            title="Certificates",
            context="homelab-traefik",
            body="Renewing TLS certificates for the reverse proxy.",
        ),
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_B,
            title="Bread Recipe",
            context="cooking",
            file_path="03-Resources/Bread.md",
            body="Knead the dough and let it rise for two hours.",
        ),
    )


def test_exact_text_ranks_first(conn, provider):
    # FakeProvider gives identical vectors for identical text -> distance 0
    seed(conn, provider)
    results = search_vector(
        conn,
        "Renewing TLS certificates for the reverse proxy.",
        Filters(),
        limit=5,
        candidates=10,
        provider=provider,
    )
    assert results[0][0] == ID_A
    assert results[0][1] > results[-1][1]


def test_dedup_to_documents(conn, provider):
    seed(conn, provider)
    long_body = "\n\n".join("Section about sourdough starter. " + "filler " * 80 for _ in range(5))
    ingest_one(
        conn,
        provider,
        make_note(
            id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            title="Long Doc",
            context="cooking",
            file_path="03-Resources/Long.md",
            body=long_body,
        ),
    )
    results = search_vector(
        conn, "sourdough starter", Filters(), limit=10, candidates=20, provider=provider
    )
    ids = [r[0] for r in results]
    assert len(ids) == len(set(ids))  # one entry per document


def test_filters_applied(conn, provider):
    seed(conn, provider)
    results = search_vector(
        conn, "certificates", Filters(context="cooking"), limit=5, candidates=10, provider=provider
    )
    assert all(r[0] == ID_B for r in results)
