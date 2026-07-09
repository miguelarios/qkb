from __future__ import annotations

import calendar
import re
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


_YEAR = re.compile(r"^\d{4}$")
_YEAR_MONTH = re.compile(r"^(\d{4})-(\d{2})$")


def _normalize_bound(label: str, value: str | None, *, upper: bool) -> str | None:
    """Expand a possibly-partial date bound to a full ISO YYYY-MM-DD.

    A bare year or year-month is expanded to the first/last day of the
    period depending on whether it's a lower (`upper=False`) or upper
    (`upper=True`) bound, so partial dates keep working against the
    lexicographically-comparable canonical `effective_date` column
    (finding 8) instead of hard-erroring or mis-comparing.
    """
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if _YEAR.match(v):
        y = int(v)
        return f"{y:04d}-12-31" if upper else f"{y:04d}-01-01"
    m = _YEAR_MONTH.match(v)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if not 1 <= mo <= 12:
            raise ValueError(f"{label}: unparseable date {value!r}")
        day = calendar.monthrange(y, mo)[1] if upper else 1
        return f"{y:04d}-{mo:02d}-{day:02d}"
    parsed = parse_date_lenient(v)
    if parsed is None:
        raise ValueError(f"{label}: unparseable date {value!r}")
    return parsed.isoformat()


def build_filter_clause(f: Filters) -> tuple[str, list]:
    conditions: list[str] = []
    params: list = []
    if f.context is not None:
        context = normalize_context(f.context)
        if context is None:
            raise ValueError("context filter is empty or whitespace-only")
        conditions.append("d.context = ?")
        params.append(context)
    if f.source is not None:
        # Mirror ingest-time treatment (parser.py strips `source`) so
        # copy-paste whitespace doesn't silently return 0 results (finding 6).
        # Source is stored case-sensitively by the parser, so strip only -
        # do NOT case-fold, unlike context.
        source = f.source.strip()
        if not source:
            raise ValueError("source filter is empty or whitespace-only")
        conditions.append("d.source = ?")
        params.append(source)
    if f.doc_type:
        conditions.append("d.type = ?")
        params.append(f.doc_type)
    date_from = _normalize_bound("date_from", f.date_from, upper=False)
    if date_from:
        conditions.append("d.effective_date >= ?")
        params.append(date_from)
    date_to = _normalize_bound("date_to", f.date_to, upper=True)
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
