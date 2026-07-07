import pytest

from qkb.config import Config
from qkb.search.filters import Filters
from qkb.search.service import execute_search
from tests.conftest import ingest_one, make_note


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
