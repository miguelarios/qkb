from qkb.search.bm25 import sanitize_query, search_bm25
from qkb.search.filters import Filters
from tests.conftest import ingest_one, make_note

W = [5.0, 3.0, 2.0, 1.0, 0.5]

ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def test_sanitize_query():
    assert sanitize_query('traefik AND "cert') == '"traefik" "AND" "cert"'
    assert sanitize_query("!!!") == ""


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
            title="Grocery List",
            context="personal",
            tags=["errands"],
            file_path="00-Inbox/Grocery List.md",
            body="Milk, eggs, bread. Also look at traefik dashboard sometime.",
        ),
    )


def test_title_match_outranks_body_mention(conn, provider):
    seed(conn, provider)
    results = search_bm25(conn, "traefik", Filters(), limit=10, weights=W)
    assert [r[0] for r in results][0] == ID_A  # title hit ranks first
    assert len(results) == 2  # body mention still found
    assert results[0][1] > results[1][1]  # higher score = better


def test_filters_applied(conn, provider):
    seed(conn, provider)
    results = search_bm25(conn, "traefik", Filters(context="personal"), limit=10, weights=W)
    assert [r[0] for r in results] == [ID_B]


def test_empty_query_returns_nothing(conn, provider):
    seed(conn, provider)
    assert search_bm25(conn, "???", Filters(), limit=10, weights=W) == []
