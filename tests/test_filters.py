import pytest

from qkb.search.filters import Filters, build_filter_clause


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


def test_context_all_whitespace_normalizes_to_no_clause():
    """normalize_context("   ") -> None; a whitespace-only context should not
    produce a context clause at all (matches ingest-time semantics)."""
    clause, params = build_filter_clause(Filters(context="   "))
    assert "d.context = ?" not in clause
    assert params == []


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
