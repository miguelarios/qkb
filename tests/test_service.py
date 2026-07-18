import pytest

from qkb.config import Config
from qkb.embed.fake import FakeProvider
from qkb.ingest.storage import Storage
from qkb.search.filters import Filters
from qkb.search.service import execute_search
from tests.conftest import DIM, ingest_one, make_note


@pytest.fixture
def cfg():
    c = Config()
    c.default_limit = 2
    return c


def test_limit_none_falls_back_to_cfg_default(conn, provider, cfg):
    for i in range(3):
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"f47ac10b-58cc-4372-a567-0e02b2c3d4{i:02d}",
                title=f"Traefik note {i}",
                body="Renewing traefik certificates.",
            ),
        )
    results = execute_search(conn, cfg, provider, "traefik", Filters(), None, "bm25")
    assert len(results) == cfg.default_limit == 2


@pytest.mark.parametrize("bad_limit", [0, -1, -10])
def test_limit_below_one_rejected(conn, provider, cfg, bad_limit):
    with pytest.raises(ValueError, match="limit must be >= 1"):
        execute_search(conn, cfg, provider, "traefik", Filters(), bad_limit, "bm25")


def test_explicit_limit_overrides_default(conn, provider, cfg):
    for i in range(3):
        ingest_one(
            conn,
            provider,
            make_note(
                id=f"f47ac10b-58cc-4372-a567-0e02b2c3d4{i:02d}",
                title=f"Traefik note {i}",
                body="Renewing traefik certificates.",
            ),
        )
    results = execute_search(conn, cfg, provider, "traefik", Filters(), 3, "bm25")
    assert len(results) == 3


def test_dimension_mismatch_raises_value_error_for_vector_and_hybrid(conn, provider, cfg):
    """Finding 5: after embedding_dim changes without a re-ingest, `chunks_vec`
    is still built at the old dimension. Vector/hybrid search must raise a
    friendly `ValueError`, not let sqlite-vec's raw `OperationalError` through.

    The query-time provider here must actually emit `cfg.embedding_dim`-length
    vectors (not the ingest-time `DIM`-length ones) — otherwise the query
    vector still matches `chunks_vec`'s real DIM-wide column and the
    underlying sqlite-vec MATCH never has anything to complain about, so the
    guard-removed control (see below) can't distinguish "prevents a crash"
    from "blocks a harmless no-op". With a mismatched query vector, removing
    the guard in `execute_search` reproduces
    `sqlite3.OperationalError: Dimension mismatch...` from sqlite-vec.
    """
    ingest_one(conn, provider, make_note())
    cfg.embedding_dim = DIM + 1  # conn's chunks_vec was created at DIM (see conftest)
    query_provider = FakeProvider(dimension=DIM + 1)

    for tier in ("vector", "hybrid"):
        with pytest.raises(ValueError, match="dimension") as exc_info:
            execute_search(conn, cfg, query_provider, "traefik", Filters(), None, tier)
        assert "--full" in str(exc_info.value)


def test_dimension_mismatch_does_not_block_bm25(conn, provider, cfg):
    """BM25 never touches `chunks_vec`, so a dimension mismatch must not block
    it — even when the query-time provider's output actually mismatches
    `chunks_vec` (see the vector/hybrid test above for why that matters)."""
    ingest_one(conn, provider, make_note())
    cfg.embedding_dim = DIM + 1
    query_provider = FakeProvider(dimension=DIM + 1)

    results = execute_search(conn, cfg, query_provider, "traefik", Filters(), None, "bm25")
    assert len(results) == 1


def test_ingest_in_progress_blocks_every_tier(conn, provider, cfg):
    """Finding 2: after an interrupted `--full`, no read path checked the
    sentinel — every vector/hybrid (and, per the brief, bm25) search should
    refuse to run against a possibly-gutted index until it's cleared.
    """
    cfg.embedding_dim = DIM  # keep the dimension guard out of this test's way
    ingest_one(conn, provider, make_note())
    Storage(conn).mark_ingest_in_progress()

    for tier in ("bm25", "vector", "hybrid"):
        with pytest.raises(ValueError, match="rebuild") as exc_info:
            execute_search(conn, cfg, provider, "traefik", Filters(), None, tier)
        assert "--full" in str(exc_info.value)

    Storage(conn).clear_ingest_in_progress()
    for tier in ("bm25", "vector", "hybrid"):
        results = execute_search(conn, cfg, provider, "traefik", Filters(), None, tier)
        assert len(results) == 1
