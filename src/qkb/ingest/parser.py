"""Frontmatter -> ParsedNote. Lenient about real-world vault data (DESIGN.md §4-5)."""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

import frontmatter

from qkb.models import ParsedNote

log = logging.getLogger(__name__)

CORE_KEYS = {"id", "type", "title", "context", "source", "date", "created", "tags"}


def parse_date_lenient(value: object) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        v = value.strip()
        if not v or v.startswith("<%"):
            return None
        try:
            return dt.datetime.fromisoformat(v).date()
        except ValueError:
            return None
    return None


def normalize_context(value: object) -> str | None:
    if value is None:
        return None
    v = str(value).strip().lower()
    return v or None


def _get(meta: dict, aliases: list[str]) -> object | None:
    for key in aliases:
        if key in meta and meta[key] not in (None, ""):
            return meta[key]
    return None


def _stringify(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    return str(value)


def parse_note(path: Path, vault_root: Path, fm_map: dict[str, list[str]]) -> ParsedNote | None:
    post = frontmatter.load(str(path))
    meta = dict(post.metadata)

    context = normalize_context(_get(meta, fm_map["context"]))
    source_raw = _get(meta, fm_map["source"])
    source = str(source_raw).strip() if source_raw is not None and str(source_raw).strip() else None
    if context is None and source is None:
        return None  # opt-in contract: not indexable

    note_id = _get(meta, fm_map["id"])
    if note_id is None:
        log.warning("skipping %s: indexable but has no id", path)
        return None

    created_raw = _get(meta, fm_map["created"])
    created_date = parse_date_lenient(created_raw)
    effective = parse_date_lenient(_get(meta, fm_map["date"])) or created_date
    if effective is None:
        log.warning("skipping %s: no parseable date", path)
        return None
    if created_raw is None:
        created_at = effective.isoformat()
    elif isinstance(created_raw, dt.date):  # covers datetime (subclass) too
        created_at = created_raw.isoformat()
    else:
        created_at = str(created_raw)

    tags_raw = _get(meta, fm_map["tags"])
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    elif isinstance(tags_raw, list):
        tags = [str(t).strip() for t in tags_raw if str(t).strip()]
    else:
        tags = []

    consumed = {alias for key in fm_map.values() for alias in key}
    extra = {
        k: _stringify(v) for k, v in meta.items() if k not in consumed and v not in (None, "", [])
    }

    title_raw = _get(meta, fm_map["title"])
    return ParsedNote(
        id=str(note_id),
        type=str(_get(meta, fm_map["type"]) or "note"),
        title=str(title_raw) if title_raw else path.stem,
        context=context,
        source=source,
        effective_date=effective.isoformat(),
        created_at=created_at,
        tags=tags,
        extra_metadata=extra,
        body=post.content,
        file_path=path.relative_to(vault_root).as_posix(),
    )
