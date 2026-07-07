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
        # A --full re-embed always starts from a clean vector index at the
        # currently-configured dimension, and always re-embeds every document
        # below (see the `full` checks in the loop) - so the guard doesn't
        # apply here. Do NOT commit the new model/dim into embedding_config
        # yet: that only happens after the loop below completes without
        # exception, so an interrupted run still fails the guard on the next
        # plain ingest (finding 3) instead of silently mixing old/new vectors.
        # Mark the in-progress sentinel now too (before the loop): an
        # interruption partway through - even with the SAME model/dim as
        # before, which `check_embedding_config` alone would not catch - must
        # also force the next plain ingest to fail rather than silently
        # leaving un-reached docs without chunks_vec entries.
        # Mark the sentinel BEFORE rebuilding the vector table: rebuild_vector_index
        # drops+recreates chunks_vec and commits, so a crash in the window between
        # that commit and the sentinel commit would otherwise leave the vector index
        # wiped with no sentinel set and the old config still valid - undetectable.
        storage.mark_ingest_in_progress()
        storage.rebuild_vector_index(provider.dimension)
    else:
        if storage.is_ingest_in_progress():
            raise RuntimeError(
                "A previous --full re-embed did not complete. "
                "Re-run with --full to finish re-embedding."
            )
        if not storage.check_embedding_config(provider.model_name, provider.dimension):
            raise RuntimeError(
                "Embedding model/config changed since last ingest. "
                "Run with --full to re-embed the whole vault."
            )

    stats = IngestStats()
    previously_indexed = storage.all_indexed_ids()
    indexed_paths = storage.indexed_paths()  # file_path -> id, snapshot from before this run
    seen: dict[str, Path] = {}  # note id -> first file path that claimed it this run
    # Doc ids whose backing file still exists but raised an exception while
    # parsing this run (e.g. a note saved mid-edit with malformed frontmatter).
    # These must be protected from the deletion sweep below (finding 2): the
    # file is present, just transiently unparseable, so the prior index entry
    # must be kept rather than treated as a deletion.
    parse_failed_ids: set[str] = set()

    for path in _vault_files(cfg.vault_path):
        stats.scanned += 1
        try:
            note = parse_note(path, cfg.vault_path, cfg.frontmatter)
        except Exception:
            log.warning("failed to parse %s; skipping", path, exc_info=True)
            stats.skipped += 1
            rel_path = path.relative_to(cfg.vault_path).as_posix()
            prior_id = indexed_paths.get(rel_path)
            if prior_id is not None:
                parse_failed_ids.add(prior_id)
            continue
        if note is None:
            stats.skipped += 1
            continue
        if note.id in seen:
            log.warning(
                "duplicate id %s: %s already claimed it this run; skipping %s",
                note.id,
                seen[note.id],
                path,
            )
            stats.skipped += 1
            continue
        seen[note.id] = path
        chash = content_hash(note.body)
        stored = storage.get_content_hash(note.id)
        if stored == chash and not full:
            # Finding 10: only a real write (frontmatter-derived metadata actually
            # changed) should touch the DB; a true no-op body+metadata match must
            # not open a transaction or bump indexed_at. Either way this document's
            # body is unchanged, so it's still counted as `unchanged` here.
            storage.update_metadata_if_changed(note, chash)
            stats.unchanged += 1
            continue
        chunks = chunk_text(note.body, cfg.chunk_target_tokens, cfg.chunk_overlap_percent)
        embeddings = provider.embed([c.text for c in chunks]) if chunks else []
        storage.upsert(note, chash, chunks, embeddings)
        if stored is None or full:
            stats.indexed += 1
        else:
            stats.updated += 1

    # Deletion sweep (DESIGN.md §7.1): de-index a previously-indexed doc only when
    # its file is genuinely gone from the vault, OR its note is a true opt-out
    # (parse_note returned None - no context AND no source). We exclude
    # `parse_failed_ids` (finding 2): a file that still exists but failed this run
    # keeps its last-good index entry. parse_note now makes that distinction for
    # us - an unindexable opted-in note (missing id or no parseable date) raises
    # NoteDataError instead of returning None, so it's caught above, resolved to a
    # doc id via file_path, and added to parse_failed_ids. Thus only true opt-outs
    # and truly-absent files fall through to de-indexing here.
    for gone in (previously_indexed - set(seen)) - parse_failed_ids:
        storage.delete(gone)
        stats.deindexed += 1

    if full:
        # The whole vault was just re-embedded with this model/dim without
        # error - commit it as current now, last, so a run that raised above
        # never reaches this line. Clear the in-progress sentinel right after:
        # any exception between mark_ingest_in_progress() (above) and here
        # leaves the sentinel SET, which is exactly what forces the next plain
        # ingest to fail until --full is re-run to completion.
        storage.commit_embedding_config(provider.model_name, provider.dimension)
        storage.clear_ingest_in_progress()

    return stats
