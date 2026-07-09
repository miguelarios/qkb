import pytest

from qkb.search.bm25 import search_bm25
from qkb.search.filters import Filters, build_filter_clause
from tests.conftest import ingest_one, make_note

W = [5.0, 3.0, 2.0, 1.0, 0.5]


def test_empty():
    clause, params = build_filter_clause(Filters())
    assert clause == "1=1" and params == []


def test_all_fields():
    clause, params = build_filter_clause(
        Filters(
            context="Homelab ",
            doc_type="note",
            tags=["a", "b"],
            date_from="2026-01-01",
            date_to="2026-12-31",
            source="s1",
        )
    )
    assert "d.context = ?" in clause and "d.type = ?" in clause and "d.source = ?" in clause
    assert "d.effective_date >= ?" in clause and "d.effective_date <= ?" in clause
    assert "HAVING COUNT(DISTINCT tag) = ?" in clause
    assert params[0] == "homelab"  # normalized
    assert params[-1] == 2  # tag count


def test_context_uses_shared_normalizer():
    """8a: context normalization must go through qkb.ingest.parser.normalize_context,
    not a hand-rolled strip().lower(), so behavior can't silently diverge."""
    clause, params = build_filter_clause(Filters(context="  Homelab  "))
    assert "d.context = ?" in clause
    assert params[0] == "homelab"


def test_context_whitespace_only_raises():
    """Finding 7: normalize_context("   ") -> None, but the caller DID pass a
    context filter (as opposed to omitting it). Silently dropping the clause
    would run the query unfiltered, which an LLM caller reads as "the filter
    matched these". Must raise instead."""
    with pytest.raises(ValueError, match="context"):
        build_filter_clause(Filters(context="   "))


def test_context_none_produces_no_clause():
    clause, params = build_filter_clause(Filters(context=None))
    assert "d.context = ?" not in clause
    assert params == []


def test_source_is_stripped():
    """Finding 6: ingest stores `source` stripped; the filter must mirror that
    so copy-paste whitespace doesn't silently return 0 results."""
    clause, params = build_filter_clause(Filters(source=" foo "))
    assert "d.source = ?" in clause
    assert params[0] == "foo"


def test_source_whitespace_only_raises():
    with pytest.raises(ValueError, match="source"):
        build_filter_clause(Filters(source="   "))


def test_source_none_produces_no_clause():
    clause, params = build_filter_clause(Filters(source=None))
    assert "d.source = ?" not in clause
    assert params == []


def test_source_not_case_folded():
    """Design call (finding 6): source is stored case-sensitively by the
    parser, so the filter must strip but NOT lowercase it."""
    clause, params = build_filter_clause(Filters(source=" MixedCase-Source "))
    assert params[0] == "MixedCase-Source"


def test_date_from_normalizes_datetime_to_canonical_date():
    """8b: a full timestamp must collapse to canonical ISO YYYY-MM-DD before the
    lexicographic compare, matching the canonical effective_date stored at ingest."""
    clause, params = build_filter_clause(Filters(date_from="2026-07-07T10:00:00"))
    assert "d.effective_date >= ?" in clause
    assert params[0] == "2026-07-07"


def test_date_to_normalizes_datetime_to_canonical_date():
    clause, params = build_filter_clause(Filters(date_to="2026-07-07T23:59:59"))
    assert "d.effective_date <= ?" in clause
    assert params[0] == "2026-07-07"


def test_unparseable_date_from_raises_instead_of_mis_filtering():
    """Non-zero-padded dates like '2026-7-7' aren't parseable by the ingest-time
    lenient parser either; per the fix, that must raise a clear error rather than
    silently mis-filter via a raw lexicographic string compare."""
    with pytest.raises(ValueError, match="date_from"):
        build_filter_clause(Filters(date_from="2026-7-7"))


def test_unparseable_date_to_raises_instead_of_mis_filtering():
    with pytest.raises(ValueError, match="date_to"):
        build_filter_clause(Filters(date_to="2026-7-7"))


def test_date_from_year_expands_to_first_day():
    """Finding 8: a bare year lower bound must expand to Jan 1, not raise."""
    clause, params = build_filter_clause(Filters(date_from="2026"))
    assert "d.effective_date >= ?" in clause
    assert params[0] == "2026-01-01"


def test_date_to_year_expands_to_last_day():
    clause, params = build_filter_clause(Filters(date_to="2026"))
    assert "d.effective_date <= ?" in clause
    assert params[0] == "2026-12-31"


def test_date_from_year_month_expands_to_first_day():
    clause, params = build_filter_clause(Filters(date_from="2026-02"))
    assert params[0] == "2026-02-01"


def test_date_to_year_month_expands_to_last_day_non_leap_february():
    """2026 is not a leap year - Feb has 28 days, not 29."""
    clause, params = build_filter_clause(Filters(date_to="2026-02"))
    assert params[0] == "2026-02-28"


def test_date_full_iso_passes_through():
    clause, params = build_filter_clause(Filters(date_from="2026-03-15"))
    assert params[0] == "2026-03-15"


def test_date_from_year_month_out_of_range_raises():
    with pytest.raises(ValueError, match="date_from"):
        build_filter_clause(Filters(date_from="2026-13"))


def test_date_garbage_raises():
    with pytest.raises(ValueError, match="date_from"):
        build_filter_clause(Filters(date_from="garbage"))


def test_partial_date_from_filters_real_search(conn, provider):
    """End-to-end: a bare-year --date-from should actually include docs dated
    in that year via search_bm25, not just build a clause in isolation."""
    ingest_one(
        conn,
        provider,
        make_note(
            id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            title="Old Traefik Note",
            context="homelab-traefik",
            effective_date="2025-06-01",
            file_path="02-Areas/Homelab/Old Traefik Note.md",
            body="Renewing certificates requires restarting the proxy.",
        ),
    )
    ingest_one(
        conn,
        provider,
        make_note(
            id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            title="New Traefik Note",
            context="homelab-traefik",
            effective_date="2026-03-15",
            file_path="02-Areas/Homelab/New Traefik Note.md",
            body="Renewing certificates requires restarting the proxy.",
        ),
    )
    results = search_bm25(conn, "traefik", Filters(date_from="2026"), limit=10, weights=W)
    assert [r[0] for r in results] == ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
