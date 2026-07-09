import logging

import pytest

from qkb.config import Config
from qkb.embed.fake import FakeProvider
from qkb.ingest.pipeline import ingest_vault


def write_note(vault, name, note_id, context="homelab", body="Some body text.", extra=""):
    p = vault / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        f"---\nid: {note_id}\ncontext: {context}\n"
        f"created: 2026-01-01T00:00:00-06:00\n{extra}---\n\n{body}\n"
    )
    return p


@pytest.fixture
def vault(tmp_path):
    v = tmp_path / "vault"
    v.mkdir()
    (v / ".obsidian").mkdir()
    (v / ".obsidian" / "ignore-me.md").write_text("no frontmatter")
    return v


@pytest.fixture
def cfg(vault, tmp_path):
    c = Config()
    c.vault_path = vault
    c.db_path = tmp_path / "qkb.db"
    c.embedding_provider = "fake"
    c.embedding_dim = 8
    return c


ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401"
ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402"


def test_ingest_new_and_unchanged_and_updated(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    stats = ingest_vault(conn, cfg, provider)
    assert stats.indexed == 2 and stats.scanned >= 2

    stats = ingest_vault(conn, cfg, provider)  # no changes
    assert stats.unchanged == 2 and stats.indexed == 0

    write_note(vault, "a.md", ID1, body="Edited body!")  # content change
    stats = ingest_vault(conn, cfg, provider)
    assert stats.updated == 1 and stats.unchanged == 1


def test_optout_and_file_deletion_deindex(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    write_note(vault, "b.md", ID2)
    ingest_vault(conn, cfg, provider)

    # opt out: rewrite without context/source
    (vault / "a.md").write_text(f"---\nid: {ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nx\n")
    # deletion: remove b.md entirely
    (vault / "b.md").unlink()
    stats = ingest_vault(conn, cfg, provider)
    assert stats.deindexed == 2
    assert conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"] == 0


def test_model_switch_requires_full(conn, provider, cfg, vault):
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)
    from qkb.embed.fake import FakeProvider

    other = FakeProvider(dimension=8)
    other_name = "different-model"
    other.__class__ = type("P", (FakeProvider,), {"model_name": property(lambda s: other_name)})
    with pytest.raises(RuntimeError, match="--full"):
        ingest_vault(conn, cfg, other)
    stats = ingest_vault(conn, cfg, other, full=True)
    assert stats.indexed == 1


def test_full_reembed_across_dimension_change_rebuilds_vector_index(conn, provider, cfg, vault):
    """Finding 1: switching to a wider embedding dimension and running --full must
    rebuild chunks_vec instead of crashing on the first mismatched-dimension insert."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # indexed at dim=8

    wider = FakeProvider(dimension=16)
    stats = ingest_vault(conn, cfg, wider, full=True)  # must not raise sqlite-vec dim mismatch
    assert stats.indexed == 2

    chunk_count = conn.execute("SELECT COUNT(*) c FROM chunks").fetchone()["c"]
    vec_count = conn.execute("SELECT COUNT(*) c FROM chunks_vec").fetchone()["c"]
    assert chunk_count > 0
    assert vec_count == chunk_count

    import sqlite_vec

    qvec = wider.embed_query("Another note body")
    row = conn.execute(
        "SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1",
        (sqlite_vec.serialize_float32(qvec),),
    ).fetchone()
    assert row is not None


class _ExplodingProvider(FakeProvider):
    """FakeProvider under a different model name that fails after N embed() calls,
    simulating an Ollama crash / Ctrl-C partway through a --full re-embed."""

    def __init__(self, dimension: int, model_name: str, fail_after: int):
        super().__init__(dimension=dimension)
        self._model_name_override = model_name
        self._fail_after = fail_after
        self._calls = 0

    @property
    def model_name(self) -> str:
        return self._model_name_override

    def embed(self, texts: list[str]) -> list[list[float]]:
        self._calls += 1
        if self._calls > self._fail_after:
            raise RuntimeError("simulated interruption")
        return super().embed(texts)


def test_parse_exception_on_present_file_does_not_deindex(conn, provider, cfg, vault, caplog):
    """Finding 2: a note that fails to parse (exception) this run, but whose file
    is still present in the vault, must keep its prior index entry - only a
    genuinely-deleted file should be de-indexed."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "b.md", ID2)
    ingest_vault(conn, cfg, provider)

    # a.md gets a mid-edit save with malformed YAML frontmatter (parse raises)
    (vault / "a.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")
    # b.md is genuinely deleted
    (vault / "b.md").unlink()

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.deindexed == 1  # only the genuinely-deleted b.md
    assert stats.skipped >= 1  # a.md's parse failure is counted, not silently dropped

    # a.md's prior rows are still intact and searchable
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?", (ID1,)).fetchone()[
            "c"
        ]
        == 1
    )
    # b.md is fully gone
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID2,)).fetchone()["c"] == 0
    )


def test_opted_in_note_becoming_date_unparseable_is_protected(conn, provider, cfg, vault, caplog):
    """Finding 2 (follow-up): a previously-indexed, still-opted-in note whose only
    date field becomes unparseable this run (frontmatter still valid YAML) must
    NOT be de-indexed. parse_note now RAISES NoteDataError for this case, which the
    pipeline's except branch catches and protects via file_path."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "b.md", ID2)
    ingest_vault(conn, cfg, provider)

    # a.md: still opted in (context present), valid YAML, but its only date is a
    # Templater placeholder that doesn't parse -> parse_note raises NoteDataError.
    (vault / "a.md").write_text(
        f"---\nid: {ID1}\ncontext: homelab\ncreated: <% tp.date.now() %>\n---\n\nstill here\n"
    )

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.deindexed == 0
    assert stats.skipped >= 1
    # a.md's prior rows survive and remain searchable
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?", (ID1,)).fetchone()[
            "c"
        ]
        == 1
    )

    # But a genuine opt-out (remove context AND source) still de-indexes.
    (vault / "a.md").write_text(
        f"---\nid: {ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nno longer indexable\n"
    )
    stats2 = ingest_vault(conn, cfg, provider)
    assert stats2.deindexed == 1
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 0
    )


def test_new_unindexable_opted_in_file_is_skipped_not_crashed(conn, provider, cfg, vault, caplog):
    """Finding 2 (follow-up): a brand-new, never-indexed, opted-in file that is
    unindexable (unparseable date -> parse_note raises NoteDataError) must be
    caught and skipped - no crash, nothing to protect, nothing to de-index."""
    (vault / "broken.md").write_text(
        f"---\nid: {ID1}\ncontext: homelab\nsource: somewhere\n"
        "date: <% tp.date.now() %>\n---\n\nx\n"
    )

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.indexed == 0
    assert stats.deindexed == 0
    assert stats.skipped >= 1
    assert conn.execute("SELECT COUNT(*) c FROM documents").fetchone()["c"] == 0


def test_duplicate_frontmatter_id_skips_second_and_no_ping_pong(conn, provider, cfg, vault, caplog):
    """Finding 4: two files sharing the same frontmatter id must not silently
    overwrite each other - the first (sorted) file wins, the duplicate is
    warned about and counted, and re-ingesting must not ping-pong re-embed."""
    write_note(vault, "a.md", ID1, body="First body.")
    write_note(vault, "z-dup.md", ID1, body="Second body claiming the same id.")

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.indexed == 1  # only the first (sorted) file was indexed
    assert stats.skipped >= 1  # the duplicate is counted, not silently absorbed
    assert any("duplicate" in r.message.lower() for r in caplog.records)

    row = conn.execute("SELECT file_path FROM documents WHERE id = ?", (ID1,)).fetchone()
    assert row["file_path"] == "a.md"

    # a second consecutive ingest must not re-embed either file (no ping-pong)
    stats2 = ingest_vault(conn, cfg, provider)
    assert stats2.indexed == 0
    assert stats2.updated == 0
    assert stats2.unchanged == 1
    assert stats2.skipped >= 1


def test_unchanged_vault_reingest_is_true_noop(conn, provider, cfg, vault):
    """Finding 10: a second consecutive ingest of an unchanged vault must perform
    ZERO metadata/FTS writes (no write transaction at all per doc) and must not
    advance last_indexed_at - otherwise the staleness signal is meaningless."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)
    last_before = conn.execute("SELECT MAX(indexed_at) m FROM documents").fetchone()["m"]
    changes_before = conn.total_changes

    stats = ingest_vault(conn, cfg, provider)

    assert stats.unchanged == 2
    assert stats.indexed == 0 and stats.updated == 0
    assert conn.total_changes == changes_before  # no writes at all
    last_after = conn.execute("SELECT MAX(indexed_at) m FROM documents").fetchone()["m"]
    assert last_after == last_before


def test_frontmatter_only_change_updates_metadata_without_full_reindex(conn, provider, cfg, vault):
    """Frontmatter-only change (context here), body identical -> the metadata
    update IS applied and visible, but this is not the body-changed (upsert) path."""
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)

    write_note(vault, "a.md", ID1, context="homelab-updated")  # same body, new context
    stats = ingest_vault(conn, cfg, provider)

    assert stats.unchanged == 1
    assert stats.updated == 0  # not the body-changed path
    row = conn.execute("SELECT context FROM documents WHERE id = ?", (ID1,)).fetchone()
    assert row["context"] == "homelab-updated"
    fts_context = conn.execute(
        "SELECT context FROM documents_fts WHERE doc_id = ?", (ID1,)
    ).fetchone()["context"]
    assert fts_context == "homelab-updated"


def test_body_change_still_triggers_full_reindex(conn, provider, cfg, vault):
    """Regression: a body change must still go through the full upsert path even
    with the no-op metadata fast-path in place."""
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)

    write_note(vault, "a.md", ID1, body="Edited body!")
    stats = ingest_vault(conn, cfg, provider)

    assert stats.updated == 1
    assert stats.unchanged == 0
    row = conn.execute("SELECT body FROM documents_fts WHERE doc_id = ?", (ID1,)).fetchone()
    assert "Edited body!" in row["body"]


def test_pure_rename_refreshes_file_path(conn, provider, cfg, vault):
    """Regression (finding 10 fix follow-up): renaming a note on disk with the
    same id, body, and frontmatter (explicit title so it doesn't fall back to
    the filename stem) must refresh documents.file_path - otherwise raw-content
    reads and obsidian:// links point at a now-nonexistent path forever."""
    write_note(vault, "old-name.md", ID1, extra="title: Stable Title\n")
    ingest_vault(conn, cfg, provider)
    assert (
        conn.execute("SELECT file_path FROM documents WHERE id = ?", (ID1,)).fetchone()["file_path"]
        == "old-name.md"
    )

    # Rename the file: same id, same body, same frontmatter (incl. explicit title).
    (vault / "old-name.md").rename(vault / "new-name.md")
    stats = ingest_vault(conn, cfg, provider)

    assert stats.unchanged == 1  # body unchanged, still the fast path
    row = conn.execute("SELECT file_path FROM documents WHERE id = ?", (ID1,)).fetchone()
    assert row["file_path"] == "new-name.md"


def test_reserved_metadata_key_in_frontmatter_does_not_crash(conn, provider, cfg, vault):
    """A note whose frontmatter contains the reserved __qkb_meta_hash__ key must
    not crash the whole ingest run (UNIQUE constraint on (document_id, key)).
    The reserved key must not be surfaced as user metadata."""
    write_note(vault, "evil.md", ID1, extra="__qkb_meta_hash__: evil\n")

    stats = ingest_vault(conn, cfg, provider)  # must not raise

    assert stats.indexed == 1
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )
    # the reserved key must not be exposed as if it were user-provided metadata
    from qkb.ingest.storage import _METADATA_HASH_KEY

    user_meta = {
        r["key"]: r["value"]
        for r in conn.execute(
            "SELECT key, value FROM metadata WHERE document_id = ? AND key != ?",
            (ID1, _METADATA_HASH_KEY),
        )
    }
    assert "__qkb_meta_hash__" not in user_meta


def test_interrupted_full_reembed_does_not_commit_new_model(conn, provider, cfg, vault):
    """Finding 3: an interrupted --full (fails partway through the document loop) must
    NOT commit the new model into embedding_config — the guard must still fire on the
    next plain ingest, forcing the user to re-run --full."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # committed as fake-8d

    model_b = _ExplodingProvider(dimension=8, model_name="model-b", fail_after=1)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        ingest_vault(conn, cfg, model_b, full=True)

    # the interrupted full run must not have committed model-b as current
    with pytest.raises(RuntimeError, match="--full"):
        ingest_vault(conn, cfg, model_b, full=False)


def test_interrupted_same_model_full_reembed_blocks_next_plain_ingest(conn, provider, cfg, vault):
    """Generalization of finding 3: an interrupted --full with the SAME model/dim
    as before is NOT caught by check_embedding_config (no mismatch) - previously
    this let a subsequent plain ingest pass the guard, see unchanged body+metadata
    hashes for un-reached docs, and never re-embed them, leaving orphaned `chunks`
    rows with no `chunks_vec` entries (silent disappearance from vector/hybrid
    search). The ingest_in_progress sentinel must catch this regardless of model
    identity."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # committed as fake-8d

    same_model = _ExplodingProvider(dimension=8, model_name=provider.model_name, fail_after=1)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        ingest_vault(conn, cfg, same_model, full=True)

    # a subsequent plain ingest - even with the original, non-exploding provider,
    # whose model/dim still matches embedding_config - must refuse to proceed
    # until --full completes.
    with pytest.raises(RuntimeError, match="--full"):
        ingest_vault(conn, cfg, provider, full=False)


def test_full_reembed_after_interruption_recovers_and_clears_sentinel(conn, provider, cfg, vault):
    """A --full run after an interruption is the recovery path: it must succeed
    and clear the sentinel, after which a following plain ingest works normally."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)

    same_model = _ExplodingProvider(dimension=8, model_name=provider.model_name, fail_after=1)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        ingest_vault(conn, cfg, same_model, full=True)

    stats = ingest_vault(conn, cfg, provider, full=True)  # recovery run must succeed
    assert stats.indexed == 2

    stats2 = ingest_vault(conn, cfg, provider, full=False)  # sentinel cleared, works normally
    assert stats2.unchanged == 2


def test_clean_full_reembed_leaves_sentinel_cleared(conn, provider, cfg, vault):
    """Regression: a clean (non-interrupted) --full leaves the sentinel cleared,
    and normal plain ingests are unaffected."""
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)

    stats = ingest_vault(conn, cfg, provider, full=True)
    assert stats.indexed == 1

    stats2 = ingest_vault(conn, cfg, provider, full=False)
    assert stats2.unchanged == 1


def test_renamed_note_that_fails_to_parse_is_not_deindexed(conn, provider, cfg, vault, caplog):
    """Finding 4: a note renamed AND made unparseable in the same run can't be
    resolved back to its old id by file_path (the new path was never indexed
    under that name), so parse_failed_ids alone can't protect it. It must
    still not be treated as a genuine deletion - an unresolved parse failure
    this run (finding 4's signature) protects the whole sweep instead."""
    write_note(vault, "a.md", ID1)
    ingest_vault(conn, cfg, provider)

    (vault / "a.md").unlink()
    (vault / "renamed.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.deindexed == 0
    assert stats.skipped >= 1
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )


def test_unrelated_deletion_deferred_during_unresolved_parse_failure(
    conn, provider, cfg, vault, caplog
):
    """Documents the accepted trade-off in the sweep's `unresolved_failures` guard:
    it is a whole-run boolean, not scoped to any directory or id, so a genuinely
    deleted-and-unrelated doc is deferred (not de-indexed) in the SAME run where
    any other file fails to parse at an unrecognized path. This is deliberate -
    scoping the protection would re-break finding 4's cross-directory rename
    case - and self-heals as soon as a run has zero parse failures."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "unrelated/b.md", ID2, body="Unrelated note body.")
    ingest_vault(conn, cfg, provider)

    # Run 2: genuinely delete a.md, AND introduce an unrelated new file at a
    # never-before-seen path with malformed frontmatter (unresolved parse failure).
    (vault / "a.md").unlink()
    (vault / "new-broken.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider)

    assert stats.deindexed == 0  # a.md's deletion is deferred, not applied
    assert stats.skipped >= 1
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )

    # Run 3: parse-clean (remove the malformed file); a.md is still gone.
    (vault / "new-broken.md").unlink()
    stats2 = ingest_vault(conn, cfg, provider)

    assert stats2.deindexed == 1  # now that no parse failures are unresolved, it de-indexes
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 0
    )


def test_full_same_dimension_does_not_wipe_vector_table_for_protected_doc(
    conn, provider, cfg, vault, caplog
):
    """Finding 1 + finding 2 (read-atomicity half): a --full at the SAME
    dimension as the existing chunks_vec must not DROP/recreate it - so a doc
    protected from de-indexing by a transient parse failure keeps its
    already-embedded vectors intact, rather than losing them to an
    unconditional wipe with no re-embed to follow."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)

    b_chunk_ids = [
        r["id"] for r in conn.execute("SELECT id FROM chunks WHERE document_id = ?", (ID2,))
    ]
    assert b_chunk_ids
    marks = ",".join("?" * len(b_chunk_ids))
    vec_count_before = conn.execute(
        f"SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN ({marks})", b_chunk_ids
    ).fetchone()["c"]
    assert vec_count_before == len(b_chunk_ids)

    (vault / "sub/b.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")

    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, provider, full=True)  # same dimension (8)

    assert stats.deindexed == 0
    vec_count_after = conn.execute(
        f"SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN ({marks})", b_chunk_ids
    ).fetchone()["c"]
    assert vec_count_after == vec_count_before


def test_full_dimension_change_clears_content_hash_for_protected_doc_and_later_reembeds(
    conn, provider, cfg, vault, caplog
):
    """Finding 1: a --full that DOES change dimension (and therefore wipes
    chunks_vec) must clear content_hash on any doc it protected-but-couldn't-
    re-embed, so a later successful parse of that doc takes the re-embed path
    instead of silently staying vector-less forever."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    ingest_vault(conn, cfg, provider)  # dim=8

    (vault / "sub/b.md").write_text("---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n")

    wider = FakeProvider(dimension=16)
    with caplog.at_level(logging.WARNING):
        stats = ingest_vault(conn, cfg, wider, full=True)  # dimension change -> wipes table

    assert stats.deindexed == 0
    row = conn.execute("SELECT content_hash FROM documents WHERE id = ?", (ID2,)).fetchone()
    assert row["content_hash"] == ""

    # fix b.md and run a plain ingest with the now-current (wider) provider
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    cfg.embedding_dim = 16
    stats2 = ingest_vault(conn, cfg, wider, full=False)

    assert stats2.updated == 1  # stored hash was '' (not None), so this is the update path
    b_chunk_ids = [
        r["id"] for r in conn.execute("SELECT id FROM chunks WHERE document_id = ?", (ID2,))
    ]
    assert b_chunk_ids
    marks = ",".join("?" * len(b_chunk_ids))
    vec_count = conn.execute(
        f"SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN ({marks})", b_chunk_ids
    ).fetchone()["c"]
    assert vec_count == len(b_chunk_ids)
    row2 = conn.execute("SELECT content_hash FROM documents WHERE id = ?", (ID2,)).fetchone()
    assert row2["content_hash"] != ""


def test_single_scan_sweep_still_deindexes_pure_deletion(conn, provider, cfg, vault):
    """Below-cut: guards that consolidating to a single indexed_paths() scan
    (plus the new parse_failed_paths/unresolved_failures bookkeeping) didn't
    change sweep results for the ordinary case - a genuinely-removed file with
    NO parse failures anywhere this run must still be de-indexed, alongside an
    unrelated update, with correct stats."""
    write_note(vault, "a.md", ID1)
    write_note(vault, "sub/b.md", ID2, body="Another note body.")
    stats = ingest_vault(conn, cfg, provider)
    assert stats.indexed == 2

    write_note(vault, "a.md", ID1, body="Edited body!")  # update
    (vault / "sub/b.md").unlink()  # genuine deletion, no parse failures this run

    stats2 = ingest_vault(conn, cfg, provider)

    assert stats2.updated == 1
    assert stats2.deindexed == 1
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID2,)).fetchone()["c"] == 0
    )
    assert (
        conn.execute("SELECT COUNT(*) c FROM documents WHERE id = ?", (ID1,)).fetchone()["c"] == 1
    )
