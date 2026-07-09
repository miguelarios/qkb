"""Ingestion orchestration: walk, diff, embed, store (DESIGN.md §7.1)."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from qkb.config import Config
from qkb.db import vector_table_dimension
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
    rebuilt = False
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
        # Mark the sentinel BEFORE checking/rebuilding the vector table: rebuild_vector_index
        # drops+recreates chunks_vec and commits, so a crash in the window between
        # that commit and the sentinel commit would otherwise leave the vector index
        # wiped with no sentinel set and the old config still valid - undetectable.
        storage.mark_ingest_in_progress()
        # Finding 2 (read-atomicity half): only DROP/recreate chunks_vec when the
        # embedding dimension actually changed. An unconditional rebuild wiped a
        # perfectly good vector index on every --full, leaving a concurrent reader
        # (the long-lived MCP server) staring at an empty-then-slowly-refilling
        # index for the entire run even when nothing about the dimension changed.
        # `connect()` already created chunks_vec at provider.dimension for a fresh
        # DB, so when the dimension is unchanged there is nothing to rebuild.
        rebuilt = vector_table_dimension(conn) != provider.dimension
        if rebuilt:
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
    # Single scan (below-the-cut dedup): everything the sweep needs is derived
    # from this one indexed_paths() call rather than a second all_indexed_ids()
    # full-table scan.
    indexed_paths = storage.indexed_paths()  # file_path -> id, snapshot from before this run
    previously_indexed = set(indexed_paths.values())
    seen: dict[str, Path] = {}  # note id -> first file path that claimed it this run
    # Doc ids whose backing file still exists but raised an exception while
    # parsing this run (e.g. a note saved mid-edit with malformed frontmatter).
    # These must be protected from the deletion sweep below (finding 2): the
    # file is present, just transiently unparseable, so the prior index entry
    # must be kept rather than treated as a deletion.
    parse_failed_ids: set[str] = set()
    # Vault-relative paths that failed to parse this run, regardless of
    # whether they resolved to a prior doc id (finding 4). A path that fails
    # to parse AND isn't a recognized prior path is the signature of a
    # renamed-or-new file that also failed this run - it can't be linked back
    # to whatever old id it used to be, so the sweep below can't tell it apart
    # from a real deletion by id alone.
    parse_failed_paths: set[str] = set()

    for path in _vault_files(cfg.vault_path):
        stats.scanned += 1
        try:
            note = parse_note(path, cfg.vault_path, cfg.frontmatter)
        except Exception:
            log.warning("failed to parse %s; skipping", path, exc_info=True)
            stats.skipped += 1
            rel_path = path.relative_to(cfg.vault_path).as_posix()
            parse_failed_paths.add(rel_path)
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

    # True iff some file failed to parse at a path we don't recognize from a
    # prior run (finding 4: a renamed note that also fails to parse can't be
    # linked back to its old id via file_path, so a missing stored path might
    # be that renamed note rather than a real deletion - protect the whole
    # sweep this run rather than risk purging it).
    unresolved_failures = any(p not in indexed_paths for p in parse_failed_paths)

    # Deletion sweep (DESIGN.md §7.1): de-index a previously-indexed doc only when
    # its file is genuinely gone from the vault, OR its note is a true opt-out
    # (parse_note returned None - no context AND no source). A doc is protected
    # from de-indexing when it resolved to a same-path parse failure this run
    # (`parse_failed_ids`, finding 2), or when some file failed to parse at an
    # unrecognized path this run (`unresolved_failures`, finding 4).
    #
    # Deliberate deviation from the brief's literal `file_present` check (a raw
    # `(cfg.vault_path / stored_rel).exists()` test, OR'd in independent of any
    # parse failure this run): that check is true whenever *anything* now sits
    # at a doc's old stored path, including a genuine opt-out (file edited to
    # drop context/source, same path, no exception) or an unrelated new note
    # reusing a freed path - both cases the existing suite (and DESIGN.md's
    # opt-out contract) require to still de-index. In every scenario this task
    # actually needs to protect (transient same-path failure, finding 4's
    # renamed-and-failed note), the doc's id or path is already resolved by
    # `parse_failed_ids`/`unresolved_failures` above, so the extra check is
    # redundant for the intended cases and unsound for the unintended ones.
    for gone in previously_indexed - set(seen):
        if gone in parse_failed_ids or unresolved_failures:
            if full and rebuilt:
                # Finding 1: a --full that WIPED the vector table left this
                # protected doc with no vectors but its old content_hash, so
                # plain ingests would skip it forever. Clear the hash so the
                # next successful parse re-embeds it.
                storage.clear_content_hash(gone)
            continue
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
