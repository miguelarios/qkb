from qkb.config import Config
from qkb.search.filters import Filters
from qkb.search.hybrid import rrf_merge, search
from tests.conftest import ingest_one, make_note

ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def test_rrf_merge_scores():
    l1 = [("a", 9.0), ("b", 5.0)]
    l2 = [("b", 0.9), ("a", 0.5)]
    merged = rrf_merge([l1, l2], k=60)
    scores = dict(merged)
    assert scores["a"] == (1 / 61) + (1 / 62)
    assert scores["b"] == (1 / 62) + (1 / 61)
    weighted = rrf_merge([l1, l2], k=60, weights=[2.0, 1.0])
    assert dict(weighted)["a"] == 2 * (1 / 61) + (1 / 62)


def make_cfg() -> Config:
    c = Config()
    c.embedding_provider = "fake"
    c.embedding_dim = 8
    return c


def seed(conn, provider):
    ingest_one(
        conn,
        provider,
        make_note(
            id=ID_A,
            title="Traefik Cert Renewal",
            context="homelab-traefik",
            body="Renewing certificates requires restarting the proxy.",
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
            body="Knead the dough and let it rise near the warm proxy of the oven.",
        ),
    )


def test_all_three_tiers_return_results(conn, provider):
    seed(conn, provider)
    cfg = make_cfg()
    # Exact body text of ID_A: FakeProvider embeds identical text to distance 0,
    # so the vector tier is deterministic (not hash-random); bm25/hybrid also rank ID_A.
    query = "Renewing certificates requires restarting the proxy."
    for tier in ["bm25", "vector", "hybrid"]:
        results = search(conn, cfg, provider, query, Filters(), limit=5, tier=tier)
        assert results, tier
        assert results[0][0] == ID_A, tier


def test_hybrid_attaches_matched_text(conn, provider):
    seed(conn, provider)
    results = search(
        conn, make_cfg(), provider, "certificates proxy", Filters(), limit=5, tier="hybrid"
    )
    doc_ids = [r[0] for r in results]
    assert ID_A in doc_ids
    assert all(isinstance(r[2], str) and r[2] for r in results)
