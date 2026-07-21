/** Ingestion orchestration: walk, diff, chunk, store, embed (DESIGN.md §7.1).
 *
 * Ported from `legacy/python/src/qkb/ingest/pipeline.py`: `ingestVault` ports
 * `ingest_vault` (both the `provider=None` STRUCTURAL path used by `qkb
 * ingest` — chunks stored WITHOUT vectors, so keyword/BM25 search works
 * immediately — and the inline-embed path taken when a provider is passed,
 * used by tests and any caller wanting ingest+embed in one shot); `embedPending`
 * ports `embed_pending`, the resumable second phase driven by `qkb embed`
 * that fills vectors in for chunks the structural pass left pending.
 *
 * The correctness-critical piece of `ingestVault` is the deletion sweep with
 * parse-failure protection (`parseFailedIds` / `unresolvedFailures`): it
 * de-indexes a previously-indexed doc ONLY when its file is genuinely gone or
 * the note is a true opt-out — never when the file is present-but-transiently-
 * unparseable, or when any file failed to parse at a path we can't link back
 * to a prior doc id (the renamed-and-failed signature). See pipeline.py's
 * block comment above the sweep for the full rationale; this port is
 * branch-for-branch equivalent.
 *
 * `embedPending`'s resumability contract: the (model, dim) is committed up
 * front (after any rebuild), and each batch's `writeVectors` call is its own
 * transaction (Storage already does this) — so an interruption (Ctrl-C, a
 * provider crash) partway through leaves every already-written batch
 * committed, and a re-run resumes from `pendingChunks()` rather than
 * restarting.
 *
 * Cooperative cancellation (`options.signal`): both loops below are, in
 * practice, fully synchronous per-iteration work (structural ingest never
 * awaits at all; the fake provider's `embed()` resolves without a real
 * event-loop yield either) — so with no `signal` passed, Node never returns
 * control to the event loop until the whole loop finishes, and an external
 * SIGINT-style interruption request would silently never be observed until
 * then. When a caller passes `signal`, each iteration `await`s a real
 * macrotask yield (`setImmediate` from `node:timers/promises` — scheduled in
 * the "check" phase, after the "poll" phase where Node processes pending
 * signal callbacks) before checking `signal.aborted`, giving a caller's own
 * `SIGINT` handler (which calls `AbortController.abort()`) an actual chance
 * to run between iterations. On abort, `ingestVault` stops before touching
 * another file and returns immediately — skipping the deletion sweep and the
 * final embedding-config commit entirely, mirroring how Python's
 * `KeyboardInterrupt` propagates out of `ingest_vault` mid-loop in
 * `pipeline.py` (nothing after the `for` loop ever runs); `embedPending`
 * stops before starting another batch (already-written batches stay
 * committed per its normal resumability contract above).
 */

import { readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { setImmediate as setImmediateAsync } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { vectorTableDimension } from "../db/schema.js";
import { contentHash, Storage } from "../db/storage.js";
import type { EmbeddingProvider } from "../embed/types.js";
import type { IngestStats } from "../types.js";
import { chunkText } from "./chunker.js";
import { NoteDataError, parseNote } from "./parser.js";

export interface IngestOptions {
  /** Inline-embed path: chunk AND embed every note as it's ingested (the
   * old single-pass behavior). Omitted/null (the default, driven by `qkb
   * ingest`) stores chunks WITHOUT vectors — `embedPending` fills them in
   * later. Only this path applies the model/dim consistency guard, the
   * `ingest_in_progress` sentinel, and the vector-table rebuild on `--full`. */
  provider?: EmbeddingProvider | null;
  /** Re-chunk and re-upsert every note, ignoring the content-hash fast path.
   * With a provider, also rebuilds+re-embeds the whole vault under the
   * provider's (possibly new) model/dim. */
  full?: boolean;
  /** Called before each file with (filesDoneSoFar, totalFiles, currentRelPath)
   * and once more at the end with (total, total, null). */
  onProgress?: (done: number, total: number, current: string | null) => void;
  /** Called with (absPath, reason) for every skipped-but-noteworthy note.
   * Reasons: `no id`, `no date`, `duplicate id (also …)`, `parse error: …`.
   * A true opt-out (parseNote returns null) is silently ignored, NOT reported. */
  onSkip?: (path: string, reason: string) => void;
  /** Cooperative cancellation — see the module docstring. Checked (with a
   * yield first) once per file; when aborted, the loop stops before the next
   * file and the deletion sweep / embedding-config commit are skipped. */
  signal?: AbortSignal;
}

export interface EmbedOptions {
  /** Clear every vector and re-embed the whole vault under the provider's
   * current model/dim, instead of refusing on a model/dim mismatch. */
  full?: boolean;
  /** Chunks per `writeVectors` transaction. Each batch commits independently,
   * so an interruption keeps prior batches and a re-run resumes from the
   * remaining `pendingChunks()`. */
  batchSize?: number;
  /** Called after each batch with (chunksDoneSoFar, totalPending, null). */
  onProgress?: (done: number, total: number, current: string | null) => void;
  /** Cooperative cancellation — see the module docstring. Checked (with a
   * yield first) once per batch; when aborted, the loop stops before the
   * next batch. Already-written batches stay committed. */
  signal?: AbortSignal;
}

/** Recursively collect every `*.md` file under `dir` (absolute paths). */
function collectMdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Mirror pipeline.py's `_vault_files`: `sorted(vault.rglob("*.md"))`, then
 * skip any whose vault-relative path has a dot-prefixed part (e.g. a note
 * inside `.obsidian/`). Python compares whole path strings; for the ASCII
 * paths this project deals in, JS's default string sort is equivalent. */
function vaultFiles(vault: string): string[] {
  return collectMdFiles(vault)
    .sort()
    .filter(
      (p) =>
        !relative(vault, p)
          .split(sep)
          .some((part) => part.startsWith(".")),
    );
}

/** Short, user-facing reason for a skipped note (from a NoteDataError). Ports
 * pipeline.py's `_skip_reason`. */
function skipReason(msg: string): string {
  if (msg.includes("no parseable date")) return "no date";
  if (msg.includes("no id")) return "no id";
  return "data error";
}

/**
 * Build the structural index (documents, chunks, BM25/FTS) from the vault.
 * With no `provider` (the default, driven by `qkb ingest`) chunks are stored
 * WITHOUT vectors — fast, keyword-searchable immediately — and `embedPending`
 * fills vectors in later. With a `provider`, vectors are written inline (the
 * old single-pass behavior; used by tests and any caller wanting ingest+embed
 * in one shot). The vector-consistency guards and the model/dim commit only
 * apply to the inline-embed path.
 *
 * Incremental: unchanged bodies are skipped (frontmatter-only changes still
 * refresh metadata), and a deletion sweep de-indexes docs whose files are
 * gone — guarded so a transient parse failure never causes silent search data
 * loss. Ports `ingest_vault` from pipeline.py branch-for-branch, including the
 * inline-embed path.
 */
export async function ingestVault(
  conn: Database.Database,
  cfg: Config,
  options: IngestOptions = {},
): Promise<IngestStats> {
  const { provider = null, full = false, onProgress, onSkip, signal } = options;
  const storage = new Storage(conn, cfg.vaultName);
  let rebuilt = false;

  if (provider !== null && full) {
    // A --full re-embed always starts from a clean vector index at the
    // currently-configured dimension, and always re-embeds every document
    // below (see the `full` checks in the loop) - so the guard doesn't apply
    // here. Do NOT commit the new model/dim into embedding_config yet: that
    // only happens after the loop below completes without exception, so an
    // interrupted run still fails the guard on the next plain ingest instead
    // of silently mixing old/new vectors.
    // Mark the in-progress sentinel now too (before the loop): an
    // interruption partway through - even with the SAME model/dim as before,
    // which checkEmbeddingConfig alone would not catch - must also force the
    // next plain ingest to fail rather than silently leaving un-reached docs
    // without chunks_vec entries.
    // Mark the sentinel BEFORE checking/rebuilding the vector table:
    // rebuildVectorIndex drops+recreates chunks_vec and commits, so a crash
    // in the window between that commit and the sentinel commit would
    // otherwise leave the vector index wiped with no sentinel set and the
    // old config still valid - undetectable.
    storage.markIngestInProgress();
    // Only DROP/recreate chunks_vec when the embedding dimension actually
    // changed. An unconditional rebuild would wipe a perfectly good vector
    // index on every --full, leaving a concurrent reader (the long-lived MCP
    // server) staring at an empty-then-slowly-refilling index for the entire
    // run even when nothing about the dimension changed. `connect()` already
    // created chunks_vec at provider.dimension for a fresh DB, so when the
    // dimension is unchanged there is nothing to rebuild.
    rebuilt = vectorTableDimension(conn) !== provider.dimension;
    if (rebuilt) {
      storage.rebuildVectorIndex(provider.dimension);
    }
  } else if (provider !== null) {
    if (storage.isIngestInProgress()) {
      throw new Error(
        "A previous --full re-embed did not complete. " +
          "Re-run with --full to finish re-embedding.",
      );
    }
    if (!storage.checkEmbeddingConfig(provider.modelName, provider.dimension)) {
      throw new Error(
        "Embedding model/config changed since last ingest. " +
          "Run with --full to re-embed the whole vault.",
      );
    }
  }

  const stats: IngestStats = {
    scanned: 0,
    indexed: 0,
    updated: 0,
    unchanged: 0,
    deindexed: 0,
    skipped: 0,
  };

  // Single scan: everything the sweep needs is derived from this one
  // indexedPaths() snapshot (taken before this run) rather than a second
  // full-table scan.
  const indexedPaths = new Map(Object.entries(storage.indexedPaths())); // file_path -> id
  const previouslyIndexed = new Set(indexedPaths.values()); // doc ids
  // Batch the per-unchanged-doc metadata-hash SELECT into one upfront query.
  const metaHashes = storage.allMetadataHashes(); // doc id -> stored metadata_hash
  const seen = new Map<string, string>(); // note id -> first abs path claiming it this run

  // Doc ids whose backing file still exists but raised while parsing this run
  // (e.g. a note saved mid-edit with malformed frontmatter). Protected from
  // the deletion sweep: the file is present, just transiently unparseable.
  const parseFailedIds = new Set<string>();
  // Vault-relative paths that failed to parse this run, regardless of whether
  // they resolved to a prior doc id. A path that fails to parse AND isn't a
  // recognized prior path is the signature of a renamed-or-new file that also
  // failed this run — it can't be linked back to whatever old id it used to
  // have, so the sweep can't tell it apart from a real deletion by id alone.
  const parseFailedPaths = new Set<string>();

  const files = vaultFiles(cfg.vaultPath);
  const total = files.length;
  let aborted = false;
  for (let i = 0; i < files.length; i++) {
    if (signal) {
      // Real macrotask yield (only paid when a caller opted in — see module
      // docstring) so a pending SIGINT-triggered `abort()` actually gets a
      // chance to run before we touch another file.
      await setImmediateAsync();
      if (signal.aborted) {
        aborted = true;
        break;
      }
    }
    const path = files[i] as string;
    const relPath = relative(cfg.vaultPath, path).split(sep).join("/");
    onProgress?.(i, total, relPath);
    stats.scanned++;

    let note: ReturnType<typeof parseNote>;
    try {
      note = parseNote(path, cfg.vaultPath, cfg.frontmatter);
    } catch (e) {
      // An opted-in note that can't be indexed (no id / unparseable date ->
      // NoteDataError), or an unexpected parse failure. Skip cleanly with a
      // one-line reason — never a traceback.
      const reason =
        e instanceof NoteDataError
          ? skipReason(e.message)
          : `parse error: ${e instanceof Error ? e.constructor.name : String(e)}`;
      onSkip?.(path, reason);
      stats.skipped++;
      parseFailedPaths.add(relPath);
      const priorId = indexedPaths.get(relPath);
      if (priorId !== undefined) parseFailedIds.add(priorId);
      continue;
    }

    if (note === null) {
      // True opt-out (no context AND no source): a legitimate de-index. Not
      // added to `seen`, so the sweep below will remove any prior entry.
      stats.skipped++;
      continue;
    }

    if (seen.has(note.id)) {
      onSkip?.(path, `duplicate id (also ${basename(seen.get(note.id) as string)})`);
      stats.skipped++;
      continue;
    }
    seen.set(note.id, path);

    const chash = contentHash(note.body);
    const stored = storage.getContentHash(note.id);
    if (stored === chash && !full) {
      // Body unchanged. Refresh frontmatter-derived metadata only if it
      // actually changed (a true no-op opens no transaction, bumps no
      // indexed_at). Counted as `unchanged` either way.
      storage.updateMetadataIfChanged(note, chash, metaHashes[note.id] ?? null);
      stats.unchanged++;
      continue;
    }

    const chunks = chunkText(note.body, cfg.chunkTargetTokens, cfg.chunkOverlapPercent);
    let embeddings: number[][] | null = null;
    if (provider !== null) {
      embeddings = chunks.length > 0 ? await provider.embed(chunks.map((c) => c.text)) : [];
    }
    // Structural pass (provider === null): no embeddings — `qkb embed` fills
    // vectors in later. Inline-embed pass: vectors written alongside chunks.
    storage.upsert(note, chash, chunks, embeddings);
    if (stored === null || full) stats.indexed++;
    else stats.updated++;
  }

  if (aborted) {
    // Mirrors Python's KeyboardInterrupt propagating out of ingest_vault
    // mid-loop (pipeline.py has no try/except around the for loop): nothing
    // below this point runs — no final onProgress "done" call, no deletion
    // sweep (a partial `seen` set would otherwise make it de-index files
    // simply not reached yet this run), no embedding-config commit. Every
    // file already processed above is already durably committed (each
    // upsert()/updateMetadataIfChanged() is its own transaction), so this is
    // safe to stop at unconditionally.
    return stats;
  }

  onProgress?.(total, total, null);

  // True iff some file failed to parse at a path we don't recognize from a
  // prior run: a renamed note that also fails to parse can't be linked back
  // to its old id via file_path, so a missing stored path might be that
  // renamed note rather than a real deletion — protect the whole sweep this
  // run rather than risk purging it.
  const unresolvedFailures = [...parseFailedPaths].some((p) => !indexedPaths.has(p));

  // Deletion sweep (DESIGN.md §7.1): de-index a previously-indexed doc only
  // when its file is genuinely gone OR its note is a true opt-out (parseNote
  // returned null). A doc is protected when it resolved to a same-path parse
  // failure this run (`parseFailedIds`), or when any file failed to parse at
  // an unrecognized path this run (`unresolvedFailures`).
  //
  // ACCEPTED TRADE-OFF: `unresolvedFailures` is a whole-run boolean, not
  // scoped to any directory or id. When ANY file fails to parse at an
  // unrecognized path, EVERY ambiguous deletion is deferred to the next
  // parse-clean ingest — even unrelated docs. We accept a briefly-stale
  // (already-deleted, still-searchable) doc for one run rather than risk
  // permanently de-indexing a present-but-renamed note (silent search data
  // loss). The deferred deletion self-heals as soon as a run has zero parse
  // failures.
  for (const gone of previouslyIndexed) {
    if (seen.has(gone)) continue;
    if (parseFailedIds.has(gone) || unresolvedFailures) {
      if (full && rebuilt) {
        // A --full that WIPED the vector table left this protected doc with
        // no vectors but its old content_hash, so plain ingests would skip
        // it forever. Clear the hash so the next successful parse re-embeds
        // it.
        storage.clearContentHash(gone);
      }
      continue;
    }
    storage.delete(gone);
    stats.deindexed++;
  }

  if (provider !== null && full) {
    // The whole vault was just re-embedded with this model/dim without error
    // - commit it as current now, last, so a run that threw above never
    // reaches this line. Clear the in-progress sentinel right after: any
    // exception between markIngestInProgress() (above) and here leaves the
    // sentinel SET, which is exactly what forces the next plain ingest to
    // fail until --full is re-run to completion.
    storage.commitEmbeddingConfig(provider.modelName, provider.dimension);
    storage.clearIngestInProgress();
  }

  return stats;
}

/**
 * Compute vectors for chunks that don't have one yet (the second phase,
 * driven by `qkb embed`). Resumable: each batch is committed, so an
 * interruption keeps its progress and a re-run continues from the remaining
 * `pendingChunks()`. Returns the number of chunks embedded.
 *
 * Model/dim consistency: vectors from different models are not mixable, so a
 * plain run refuses when the configured model/dim differs from what produced
 * the existing vectors — `--full` clears every vector and re-embeds. The
 * (model, dim) is committed up front (after any rebuild), so even a `--full`
 * interrupted midway resumes cleanly against the new model rather than
 * restarting.
 *
 * Ports `embed_pending` from pipeline.py.
 */
export async function embedPending(
  conn: Database.Database,
  cfg: Config,
  provider: EmbeddingProvider,
  options: EmbedOptions = {},
): Promise<number> {
  const { full = false, batchSize = 64, onProgress, signal } = options;
  const storage = new Storage(conn, cfg.vaultName);
  const model = provider.modelName;
  const dim = provider.dimension;

  const committed = storage.storedEmbeddingConfig();
  if (!full && committed !== null && (committed[0] !== model || committed[1] !== dim)) {
    throw new Error(
      `Embedding model/dim changed (${committed[0]} d${committed[1]} → ${model} d${dim}). ` +
        "Run `qkb embed --full` to re-embed the whole vault.",
    );
  }
  if (full || vectorTableDimension(conn) !== dim) {
    storage.rebuildVectorIndex(dim); // empties chunks_vec at the target dim
  }
  storage.commitEmbeddingConfig(model, dim);

  const pending = storage.pendingChunks();
  const total = pending.length;
  let done = 0;
  for (let start = 0; start < total; start += batchSize) {
    if (signal) {
      // See ingestVault's equivalent yield for why this is needed even
      // though `await provider.embed(...)` below is already an `await`: a
      // synchronous-under-the-hood provider (the `fake` one used in tests)
      // resolves without a real event-loop yield, so without this a pending
      // SIGINT-triggered `abort()` would never get a chance to run either.
      await setImmediateAsync();
      if (signal.aborted) {
        break;
      }
    }
    const batch = pending.slice(start, start + batchSize);
    const vectors = await provider.embed(batch.map(([, text]) => text));
    storage.writeVectors(batch.map(([cid], i) => [cid, vectors[i] as number[]]));
    done += batch.length;
    onProgress?.(done, total, null);
  }
  return done;
}
