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
