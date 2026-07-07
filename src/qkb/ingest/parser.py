"""Frontmatter -> ParsedNote. Lenient about real-world vault data (DESIGN.md §4-5)."""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import frontmatter

from qkb.models import ParsedNote

log = logging.getLogger(__name__)

CORE_KEYS = {"id", "type", "title", "context", "source", "date", "created", "tags"}


class NoteDataError(Exception):
    """An opted-in note (has `context` or `source`) cannot be indexed because of
    a data error - a missing `id`, or no parseable date.

    Raised instead of returning None so the ingest pipeline's `except Exception`
    branch treats it like any other transient parse failure: the note is logged,
    counted as `skipped`, and (if it was previously indexed) protected from the
    deletion sweep via its stored file_path. A None return is reserved for a
    TRUE opt-out (no context AND no source), which is a legitimate de-index.
    """


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


T = TypeVar("T")


def _get_parsed(
    meta: dict, aliases: list[str], parse: Callable[[object], T | None]
) -> tuple[object, T] | None:
    """Walk an alias list and return the (raw, parsed) pair for the first alias
    whose value is present, non-empty, AND satisfies `parse`.

    Unlike `_get`, a present-but-unparseable value does not stop the search:
    per DESIGN.md §5, invalid values fall through to the next alias.
    """
    for key in aliases:
        if key in meta and meta[key] not in (None, ""):
            parsed = parse(meta[key])
            if parsed is not None:
                return meta[key], parsed
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
        return None  # true opt-out (no context AND no source): a legitimate de-index

    # From here the note is OPTED IN. If it's unindexable due to a data error
    # (missing id, or no parseable date) we RAISE rather than return None, so the
    # pipeline protects a previously-indexed entry instead of de-indexing it on a
    # transient/graceful failure (finding 2). Only a true opt-out returns None.
    note_id = _get(meta, fm_map["id"])
    if note_id is None:
        raise NoteDataError(f"{path}: opted-in note has no id")

    created_hit = _get_parsed(meta, fm_map["created"], parse_date_lenient)
    date_hit = _get_parsed(meta, fm_map["date"], parse_date_lenient)
    effective = (date_hit[1] if date_hit else None) or (created_hit[1] if created_hit else None)
    if effective is None:
        raise NoteDataError(f"{path}: opted-in note has no parseable date")
    if created_hit is None:
        created_at = effective.isoformat()
    else:
        created_raw = created_hit[0]
        if isinstance(created_raw, dt.date):  # covers datetime (subclass) too
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
