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


def test_filter_restricts_candidates_before_knn(conn, provider):
    """Finding 5: a filtered vector search must not run KNN globally first and
    filter afterward, or a filter-passing match outside the global top-k is
    silently dropped (DESIGN.md §8.5 promises pre-restriction).

    FakeProvider gives identical text identical vectors -> distance 0. Seed
    many out-of-context decoy docs whose body is the exact query text (so they
    dominate the global top-k), plus one in-context target doc with unrelated
    text (nonzero distance, ranked far outside the global top-k). candidates
    is small enough that the old `k = candidates * 4` global search never
    reaches the target doc.
    """
    query = "certificate renewal steps for the reverse proxy"
    candidates = 3  # old code: k = candidates * 4 = 12
    n_decoys = 20  # >> 12, so the target is pushed well outside the old global top-k
    for i in range(n_decoys):
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"decoy-{i:04d}",
                title=f"Decoy {i}",
                context="cooking",
                file_path=f"03-Resources/Decoy{i}.md",
                body=query,  # identical text -> distance 0, globally nearest
            ),
        )
    ingest_one(
        conn,
        provider,
        make_note(
            id="target-0001",
            title="Traefik Renewal Target",
            context="homelab-traefik",
            file_path="02-Areas/Homelab/Target.md",
            body="Unrelated maintenance notes about disk usage on the NAS.",
        ),
    )

    unfiltered = search_vector(
        conn, query, Filters(), limit=5, candidates=candidates, provider=provider
    )
    assert unfiltered, "sanity: unfiltered search should still find the global nearest decoys"
    assert all(r[0].startswith("decoy-") for r in unfiltered)

    filtered = search_vector(
        conn,
        query,
        Filters(context="homelab-traefik"),
        limit=5,
        candidates=candidates,
        provider=provider,
    )
    assert filtered, (
        "filtered search must find the in-context doc even though it's outside the global top-k"
    )
    assert all(r[0] == "target-0001" for r in filtered)


def test_limit_above_candidates_not_truncated(conn, provider):
    """Finding 6: candidate k must scale with the requested limit, not just
    `candidates` — otherwise a large --limit is silently capped."""
    n_docs = 8
    for i in range(n_docs):
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"doc-{i:04d}",
                title=f"Doc {i}",
                context="homelab-traefik",
                file_path=f"02-Areas/Homelab/Doc{i}.md",
                body=f"Distinct content about topic number {i} for the search index.",
            ),
        )
    candidates = 3  # deliberately smaller than both n_docs and limit
    results = search_vector(
        conn, "topic", Filters(), limit=15, candidates=candidates, provider=provider
    )
    assert len(results) == n_docs  # not capped at `candidates`
