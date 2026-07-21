/** Ingestion orchestration: walk, diff, chunk, store (DESIGN.md §7.1).
 *
 * Ported from `legacy/python/src/qkb/ingest/pipeline.py` — specifically the
 * `ingest_vault(provider=None)` STRUCTURAL path: walk the vault, parse/chunk,
 * and `upsert` chunks WITHOUT vectors, so keyword/BM25 search works
 * immediately and a later embed pass (`embedPending`, Task 9) fills vectors
 * in. This module never touches provider/embedding code.
 *
 * The correctness-critical piece is the deletion sweep with parse-failure
 * protection (`parseFailedIds` / `unresolvedFailures`): it de-indexes a
 * previously-indexed doc ONLY when its file is genuinely gone or the note is
 * a true opt-out — never when the file is present-but-transiently-unparseable,
 * or when any file failed to parse at a path we can't link back to a prior
 * doc id (the renamed-and-failed signature). See pipeline.py's block comment
 * above the sweep for the full rationale; this port is branch-for-branch
 * equivalent on the provider=None path.
 */

import { readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { contentHash, Storage } from "../db/storage.js";
import type { IngestStats } from "../types.js";
import { chunkText } from "./chunker.js";
import { NoteDataError, parseNote } from "./parser.js";

export interface IngestOptions {
  /** Re-chunk and re-upsert every note, ignoring the content-hash fast path. */
  full?: boolean;
  /** Called before each file with (filesDoneSoFar, totalFiles, currentRelPath)
   * and once more at the end with (total, total, null). */
  onProgress?: (done: number, total: number, current: string | null) => void;
  /** Called with (absPath, reason) for every skipped-but-noteworthy note.
   * Reasons: `no id`, `no date`, `duplicate id (also …)`, `parse error: …`.
   * A true opt-out (parseNote returns null) is silently ignored, NOT reported. */
  onSkip?: (path: string, reason: string) => void;
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
 * Build the structural index (documents, chunks, BM25/FTS) from the vault,
 * storing chunks WITHOUT vectors. Incremental: unchanged bodies are skipped
 * (frontmatter-only changes still refresh metadata), and a deletion sweep
 * de-indexes docs whose files are gone — guarded so a transient parse failure
 * never causes silent search data loss.
 *
 * Ports `ingest_vault(provider=None)` from pipeline.py. The `--full` flag here
 * only re-chunks/re-upserts every note; the vector-table rebuild and the
 * ingest-in-progress sentinel are inline-embed concerns (Task 9's embed path),
 * so on this provider-less path `rebuilt` is always false and the
 * `clearContentHash` branch in the sweep is never taken.
 */
export function ingestVault(
  conn: Database.Database,
  cfg: Config,
  options: IngestOptions = {},
): IngestStats {
  const { full = false, onProgress, onSkip } = options;
  const storage = new Storage(conn, cfg.vaultName);

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
  for (let i = 0; i < files.length; i++) {
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
    // Structural pass: no embeddings — `qkb embed` fills vectors in later.
    storage.upsert(note, chash, chunks, null);
    if (stored === null || full) stats.indexed++;
    else stats.updated++;
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
      // (The `full && rebuilt` -> clearContentHash branch from pipeline.py
      // applies only to the inline-embed path, where a dimension-changing
      // --full wipes chunks_vec; `rebuilt` is always false here.)
      continue;
    }
    storage.delete(gone);
    stats.deindexed++;
  }

  return stats;
}
