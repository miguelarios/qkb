from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Filters:
    context: str | None = None
    source: str | None = None
    doc_type: str | None = None
    tags: list[str] | None = None
    date_from: str | None = None
    date_to: str | None = None


def build_filter_clause(f: Filters) -> tuple[str, list]:
    conditions: list[str] = []
    params: list = []
    if f.context:
        conditions.append("d.context = ?")
        params.append(f.context.strip().lower())
    if f.source:
        conditions.append("d.source = ?")
        params.append(f.source)
    if f.doc_type:
        conditions.append("d.type = ?")
        params.append(f.doc_type)
    if f.date_from:
        conditions.append("d.effective_date >= ?")
        params.append(f.date_from)
    if f.date_to:
        conditions.append("d.effective_date <= ?")
        params.append(f.date_to)
    if f.tags:
        marks = ",".join("?" * len(f.tags))
        conditions.append(
            f"d.id IN (SELECT document_id FROM tags WHERE tag IN ({marks}) "
            "GROUP BY document_id HAVING COUNT(DISTINCT tag) = ?)"
        )
        params.extend(f.tags)
        params.append(len(f.tags))
    return (" AND ".join(conditions) if conditions else "1=1"), params
