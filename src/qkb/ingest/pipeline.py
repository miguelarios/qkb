"""Ingestion orchestration: walk, diff, embed, store (DESIGN.md §7.1)."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
from qkb.ingest.chunker import chunk_text
from qkb.ingest.parser import parse_note
from qkb.ingest.storage import Storage, content_hash
from qkb.models import IngestStats

log = logging.getLogger(__name__)


def _vault_files(vault: Path):
    for p in sorted(vault.rglob("*.md")):
        if any(part.startswith(".") for part in p.relative_to(vault).parts):
            continue
        yield p


def ingest_vault(
    conn: sqlite3.Connection,
    cfg: Config,
    provider: EmbeddingProvider,
    full: bool = False,
) -> IngestStats:
    storage = Storage(conn, vault_name=cfg.vault_name)
    if full:
        storage.reset_embedding_config()
    if not storage.check_embedding_config(provider.model_name, provider.dimension):
        raise RuntimeError(
            "Embedding model/config changed since last ingest. "
            "Run with --full to re-embed the whole vault."
        )

    stats = IngestStats()
    previously_indexed = storage.all_indexed_ids()
    seen: set[str] = set()

    for path in _vault_files(cfg.vault_path):
        stats.scanned += 1
        try:
            note = parse_note(path, cfg.vault_path, cfg.frontmatter)
        except Exception:
            log.warning("failed to parse %s; skipping", path, exc_info=True)
            stats.skipped += 1
            continue
        if note is None:
            stats.skipped += 1
            continue
        seen.add(note.id)
        chash = content_hash(note.body)
        stored = storage.get_content_hash(note.id)
        if stored == chash and not full:
            storage.update_metadata_only(note, chash)
            stats.unchanged += 1
            continue
        chunks = chunk_text(note.body, cfg.chunk_target_tokens, cfg.chunk_overlap_percent)
        embeddings = provider.embed([c.text for c in chunks]) if chunks else []
        storage.upsert(note, chash, chunks, embeddings)
        if stored is None or full:
            stats.indexed += 1
        else:
            stats.updated += 1

    for gone in previously_indexed - seen:
        storage.delete(gone)
        stats.deindexed += 1
    return stats
