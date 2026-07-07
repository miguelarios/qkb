from __future__ import annotations

from dataclasses import dataclass

from qkb.ingest.parser import normalize_context, parse_date_lenient


@dataclass
class Filters:
    context: str | None = None
    source: str | None = None
    doc_type: str | None = None
    tags: list[str] | None = None
    date_from: str | None = None
    date_to: str | None = None


def _normalize_bound(label: str, value: str | None) -> str | None:
    if not value:
        return None
    parsed = parse_date_lenient(value)
    if parsed is None:
        raise ValueError(f"{label}: unparseable date {value!r}")
    return parsed.isoformat()


def build_filter_clause(f: Filters) -> tuple[str, list]:
    conditions: list[str] = []
    params: list = []
    context = normalize_context(f.context)
    if context:
        conditions.append("d.context = ?")
        params.append(context)
    if f.source:
        conditions.append("d.source = ?")
        params.append(f.source)
    if f.doc_type:
        conditions.append("d.type = ?")
        params.append(f.doc_type)
    date_from = _normalize_bound("date_from", f.date_from)
    if date_from:
        conditions.append("d.effective_date >= ?")
        params.append(date_from)
    date_to = _normalize_bound("date_to", f.date_to)
    if date_to:
        conditions.append("d.effective_date <= ?")
        params.append(date_to)
    if f.tags:
        marks = ",".join("?" * len(f.tags))
        conditions.append(
            f"d.id IN (SELECT document_id FROM tags WHERE tag IN ({marks}) "
            "GROUP BY document_id HAVING COUNT(DISTINCT tag) = ?)"
        )
        params.extend(f.tags)
        params.append(len(f.tags))
    return (" AND ".join(conditions) if conditions else "1=1"), params
