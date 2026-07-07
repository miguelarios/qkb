from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ParsedNote:
    id: str
    type: str
    title: str
    context: str | None
    source: str | None
    effective_date: str  # YYYY-MM-DD
    created_at: str  # full ISO 8601
    tags: list[str]
    extra_metadata: dict[str, str]
    body: str
    file_path: str  # vault-relative, POSIX separators


@dataclass
class Chunk:
    index: int
    text: str
    token_count: int


@dataclass
class IngestStats:
    scanned: int = 0
    indexed: int = 0
    updated: int = 0
    unchanged: int = 0
    deindexed: int = 0
    skipped: int = 0
