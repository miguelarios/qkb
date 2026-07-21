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


def test_long_doc_does_not_crowd_out_other_docs(conn, provider):
    """Finding 3: `k` sizes the KNN pool in CHUNKS, but results dedup to
    DOCUMENTS. A single many-chunk document whose chunks all rank nearest the
    query must not crowd the whole chunk pool and starve every other
    filter-passing document out of the document-level result set.

    One document is chunked into 12 IDENTICAL sections (FakeProvider gives
    identical text identical vectors -> distance 0 for all 12), so with the
    old fixed-size pool (k = max(candidates, limit)) every slot in a small
    pool is consumed by ties from this one document, and 15 other
    filter-passing single-chunk documents never appear at all. The fix must
    grow the pool until `limit` distinct documents are collected.
    """
    section = (
        "## Section\n\nContent block about the reverse proxy certificate renewal. "
        + "filler word " * 80
    )
    query = section
    long_body = "\n\n".join([section] * 12)
    ingest_one(
        conn,
        provider,
        make_note(
            id="long-0001",
            title="Long Doc",
            context="homelab-traefik",
            file_path="02-Areas/Homelab/Long.md",
            body=long_body,
        ),
    )
    n_singles = 15
    for i in range(n_singles):
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"single-{i:04d}",
                title=f"Single {i}",
                context="homelab-traefik",
                file_path=f"02-Areas/Homelab/Single{i}.md",
                body=f"Unrelated maintenance notes number {i} about disk usage on the NAS.",
            ),
        )
    limit = 10
    results = search_vector(
        conn,
        query,
        Filters(context="homelab-traefik"),
        limit=limit,
        candidates=5,  # deliberately small: old k = max(5, 10) = 10 chunks,
        # all consumed by the 12 tied chunks of the single long document.
        provider=provider,
    )
    ids = [r[0] for r in results]
    # 16 filter-passing docs exist (1 long + 15 singles); limit=10 < 16, so
    # the fixed result set must be exactly `limit` DISTINCT documents.
    assert len(ids) == len(set(ids)) == limit


def test_multi_chunk_docs_all_returned_when_limit_equals_doc_count(conn, provider):
    """Finding 3: several multi-chunk docs, `limit` == doc count, `candidates`
    smaller than total chunk count -> every document must be returned, not
    just the ones whose chunks happen to land in a too-small fixed pool."""
    query = "distinct content for the search index"
    n_docs = 6
    chunks_per_doc = 6
    # doc 0: every chunk identical to the query (distance 0 ties) so a
    # fixed-size small pool gets entirely consumed by this one document.
    crowding_section = (
        "## Section\n\nContent block about the reverse proxy certificate renewal. "
        + "filler word " * 80
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id="multi-0000",
            title="Multi Doc 0",
            context="homelab-traefik",
            file_path="02-Areas/Homelab/Multi0.md",
            body="\n\n".join([crowding_section] * chunks_per_doc),
        ),
    )
    for d in range(1, n_docs):
        sections = "\n\n".join(
            f"## Section {d}-{s}\n\nDistinct filler content for doc {d} section {s}. "
            + "filler word " * 80
            for s in range(chunks_per_doc)
        )
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"multi-{d:04d}",
                title=f"Multi Doc {d}",
                context="homelab-traefik",
                file_path=f"02-Areas/Homelab/Multi{d}.md",
                body=sections,
            ),
        )
    results = search_vector(
        conn,
        query,
        Filters(),  # no filter leg of the pool-sizing fix
        limit=n_docs,
        candidates=4,  # smaller than total chunks (36) and smaller than n_docs
        provider=provider,
    )
    ids = [r[0] for r in results]
    assert len(ids) == len(set(ids)) == n_docs


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
