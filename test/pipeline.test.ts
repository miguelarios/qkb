import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { ingestVault } from "../src/ingest/pipeline.js";

// Ports the STRUCTURAL cases of legacy/python/tests/test_pipeline.py — the
// provider=None path of ingest_vault (chunks stored without vectors). The
// provider-inline / sentinel / --full-reembed cases and the embed_pending
// cases belong to Task 9 and are intentionally not ported here.

const DIM = 8;
const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";

interface WriteOpts {
  context?: string;
  body?: string;
  extra?: string;
}

function writeNote(vault: string, name: string, noteId: string, opts: WriteOpts = {}): string {
  const { context = "homelab", body = "Some body text.", extra = "" } = opts;
  const p = join(vault, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    `---\nid: ${noteId}\ncontext: ${context}\ncreated: 2026-01-01T00:00:00-06:00\n${extra}---\n\n${body}\n`,
  );
  return p;
}

function totalChanges(conn: Database.Database): number {
  return (conn.prepare("SELECT total_changes() c").get() as { c: number }).c;
}

function docCount(conn: Database.Database, id: string): number {
  return (conn.prepare("SELECT COUNT(*) c FROM documents WHERE id = ?").get(id) as { c: number }).c;
}

function ftsCount(conn: Database.Database, id: string): number {
  return (
    conn.prepare("SELECT COUNT(*) c FROM documents_fts WHERE doc_id = ?").get(id) as { c: number }
  ).c;
}

describe("ingest/pipeline (structural)", () => {
  let conn: Database.Database;
  let vault: string;
  let cfg: Config;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    vault = mkdtempSync(join(tmpdir(), "qkb-vault-"));
    // mirror the Python `vault` fixture: a dot-directory with a stray .md the
    // walk must ignore.
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian", "ignore-me.md"), "no frontmatter");
    // deterministic defaults (never read the machine's real config.toml)
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = vault;
  });

  afterEach(() => {
    conn.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("indexes new, then unchanged, then updated", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    let stats = ingestVault(conn, cfg);
    expect(stats.indexed).toBe(2);
    expect(stats.scanned).toBeGreaterThanOrEqual(2);

    stats = ingestVault(conn, cfg); // no changes
    expect(stats.unchanged).toBe(2);
    expect(stats.indexed).toBe(0);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" }); // content change
    stats = ingestVault(conn, cfg);
    expect(stats.updated).toBe(1);
    expect(stats.unchanged).toBe(1);
  });

  it("--full re-indexes every note, ignoring the content-hash fast path", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    ingestVault(conn, cfg);

    // Nothing changed on disk, but --full must re-chunk/re-upsert both notes
    // (counted as indexed, since their stored hash is non-null) instead of
    // taking the unchanged fast path.
    const stats = ingestVault(conn, cfg, { full: true });
    expect(stats.indexed).toBe(2);
    expect(stats.unchanged).toBe(0);
    expect(stats.updated).toBe(0);
    // still structural: no vectors written by --full on the provider-less path
    expect(new Storage(conn).stats().vectors).toBe(0);
  });

  it("de-indexes an opt-out and a genuine file deletion", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    ingestVault(conn, cfg);

    // opt out: rewrite without context/source
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nx\n`,
    );
    // deletion: remove b.md entirely
    unlinkSync(join(vault, "b.md"));
    const stats = ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(2);
    expect((conn.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
  });

  it("is a true no-op on an unchanged re-ingest (no writes, indexed_at frozen)", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    ingestVault(conn, cfg);
    const lastBefore = (
      conn.prepare("SELECT MAX(indexed_at) m FROM documents").get() as { m: string }
    ).m;
    const changesBefore = totalChanges(conn);

    const stats = ingestVault(conn, cfg);

    expect(stats.unchanged).toBe(2);
    expect(stats.indexed).toBe(0);
    expect(stats.updated).toBe(0);
    expect(totalChanges(conn)).toBe(changesBefore); // no writes at all
    const lastAfter = (
      conn.prepare("SELECT MAX(indexed_at) m FROM documents").get() as { m: string }
    ).m;
    expect(lastAfter).toBe(lastBefore);
  });

  it("applies a frontmatter-only change without a full re-index", () => {
    writeNote(vault, "a.md", ID1);
    ingestVault(conn, cfg);

    writeNote(vault, "a.md", ID1, { context: "homelab-updated" }); // same body, new context
    const stats = ingestVault(conn, cfg);

    expect(stats.unchanged).toBe(1);
    expect(stats.updated).toBe(0); // not the body-changed path
    const ctx = (
      conn.prepare("SELECT context FROM documents WHERE id = ?").get(ID1) as { context: string }
    ).context;
    expect(ctx).toBe("homelab-updated");
    const ftsCtx = (
      conn.prepare("SELECT context FROM documents_fts WHERE doc_id = ?").get(ID1) as {
        context: string;
      }
    ).context;
    expect(ftsCtx).toBe("homelab-updated");
  });

  it("a body change still triggers a full re-index", () => {
    writeNote(vault, "a.md", ID1);
    ingestVault(conn, cfg);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" });
    const stats = ingestVault(conn, cfg);

    expect(stats.updated).toBe(1);
    expect(stats.unchanged).toBe(0);
    const body = (
      conn.prepare("SELECT body FROM documents_fts WHERE doc_id = ?").get(ID1) as { body: string }
    ).body;
    expect(body).toContain("Edited body!");
  });

  it("a pure rename refreshes documents.file_path via the fast path", () => {
    writeNote(vault, "old-name.md", ID1, { extra: "title: Stable Title\n" });
    ingestVault(conn, cfg);
    expect(
      (
        conn.prepare("SELECT file_path FROM documents WHERE id = ?").get(ID1) as {
          file_path: string;
        }
      ).file_path,
    ).toBe("old-name.md");

    // rename on disk: same id, body, frontmatter (incl. explicit title)
    const content = `---\nid: ${ID1}\ncontext: homelab\ncreated: 2026-01-01T00:00:00-06:00\ntitle: Stable Title\n---\n\nSome body text.\n`;
    unlinkSync(join(vault, "old-name.md"));
    writeFileSync(join(vault, "new-name.md"), content);
    const stats = ingestVault(conn, cfg);

    expect(stats.unchanged).toBe(1); // body unchanged, still the fast path
    expect(
      (
        conn.prepare("SELECT file_path FROM documents WHERE id = ?").get(ID1) as {
          file_path: string;
        }
      ).file_path,
    ).toBe("new-name.md");
  });

  it("a reserved-metadata-key note does not crash the run", () => {
    writeNote(vault, "evil.md", ID1, { extra: "__qkb_meta_hash__: evil\n" });

    const stats = ingestVault(conn, cfg); // must not throw

    expect(stats.indexed).toBe(1);
    expect(docCount(conn, ID1)).toBe(1);
    const userMeta = (
      conn
        .prepare("SELECT key FROM metadata WHERE document_id = ? AND key != ?")
        .all(ID1, "__qkb_meta_hash__") as { key: string }[]
    ).map((r) => r.key);
    expect(userMeta).not.toContain("__qkb_meta_hash__");
  });

  // ----- deletion-sweep protection cases (the correctness-critical ones) -----

  it("protection: parse exception on a still-present file does not de-index it", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    ingestVault(conn, cfg);

    // a.md: mid-edit save with malformed YAML frontmatter (parse raises)
    writeFileSync(join(vault, "a.md"), "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n");
    // b.md: genuinely deleted
    unlinkSync(join(vault, "b.md"));

    const stats = ingestVault(conn, cfg);

    expect(stats.deindexed).toBe(1); // only the genuinely-deleted b.md
    expect(stats.skipped).toBeGreaterThanOrEqual(1); // a.md counted, not dropped
    expect(docCount(conn, ID1)).toBe(1); // a.md's rows intact
    expect(ftsCount(conn, ID1)).toBe(1);
    expect(docCount(conn, ID2)).toBe(0); // b.md fully gone
  });

  it("protection: an opted-in note becoming date-unparseable is protected, then a genuine opt-out de-indexes", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    ingestVault(conn, cfg);

    // a.md: still opted in, valid YAML, but its only date is a Templater
    // placeholder that doesn't parse -> parseNote raises NoteDataError.
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncontext: homelab\ncreated: <% tp.date.now() %>\n---\n\nstill here\n`,
    );

    let stats = ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);
    expect(ftsCount(conn, ID1)).toBe(1);

    // But a genuine opt-out (remove context AND source) still de-indexes.
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nno longer indexable\n`,
    );
    stats = ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(1);
    expect(docCount(conn, ID1)).toBe(0);
  });

  it("protection: a brand-new unindexable opted-in file is skipped, not crashed", () => {
    writeFileSync(
      join(vault, "broken.md"),
      `---\nid: ${ID1}\ncontext: homelab\nsource: somewhere\ndate: <% tp.date.now() %>\n---\n\nx\n`,
    );

    const stats = ingestVault(conn, cfg);

    expect(stats.indexed).toBe(0);
    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect((conn.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
  });

  it("duplicate frontmatter id: first sorted wins, duplicate is reported, no ping-pong", () => {
    writeNote(vault, "a.md", ID1, { body: "First body." });
    writeNote(vault, "z-dup.md", ID1, { body: "Second body claiming the same id." });

    const skips: [string, string][] = [];
    const stats = ingestVault(conn, cfg, {
      onSkip: (p, r) => skips.push([basename(p), r]),
    });

    expect(stats.indexed).toBe(1); // only the first (sorted) file
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(skips.some(([, reason]) => reason.includes("duplicate"))).toBe(true);

    const row = conn.prepare("SELECT file_path FROM documents WHERE id = ?").get(ID1) as {
      file_path: string;
    };
    expect(row.file_path).toBe("a.md");

    // second consecutive ingest must not re-embed either file (no ping-pong)
    const stats2 = ingestVault(conn, cfg);
    expect(stats2.indexed).toBe(0);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(1);
    expect(stats2.skipped).toBeGreaterThanOrEqual(1);
  });

  it("protection: a renamed note that also fails to parse is not de-indexed", () => {
    writeNote(vault, "a.md", ID1);
    ingestVault(conn, cfg);

    unlinkSync(join(vault, "a.md"));
    writeFileSync(
      join(vault, "renamed.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const stats = ingestVault(conn, cfg);

    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);
  });

  it("trade-off: an unrelated deletion is deferred during an unresolved parse failure, then self-heals", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "unrelated/b.md", ID2, { body: "Unrelated note body." });
    ingestVault(conn, cfg);

    // Run 2: delete a.md AND add an unrelated new file at a never-seen path
    // with malformed frontmatter (unresolved parse failure).
    unlinkSync(join(vault, "a.md"));
    writeFileSync(
      join(vault, "new-broken.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const stats = ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(0); // a.md's deletion is deferred
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);

    // Run 3: parse-clean (remove the malformed file); a.md is still gone.
    unlinkSync(join(vault, "new-broken.md"));
    const stats2 = ingestVault(conn, cfg);
    expect(stats2.deindexed).toBe(1); // now it de-indexes
    expect(docCount(conn, ID1)).toBe(0);
  });

  it("the single-scan sweep still de-indexes a pure deletion alongside an update", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    const stats = ingestVault(conn, cfg);
    expect(stats.indexed).toBe(2);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" }); // update
    unlinkSync(join(vault, "sub/b.md")); // genuine deletion, no parse failures

    const stats2 = ingestVault(conn, cfg);

    expect(stats2.updated).toBe(1);
    expect(stats2.deindexed).toBe(1);
    expect(docCount(conn, ID2)).toBe(0);
    expect(docCount(conn, ID1)).toBe(1);
  });

  it("an all-unchanged re-ingest uses batched metadata hashes (no per-doc getMetadataHash)", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    ingestVault(conn, cfg);

    const spy = vi.spyOn(Storage.prototype, "getMetadataHash");
    const stats = ingestVault(conn, cfg);

    expect(spy).not.toHaveBeenCalled();
    expect(stats.unchanged).toBe(2);
    spy.mockRestore();
  });

  it("reports categorized skip reasons and drives progress to completion", () => {
    writeNote(vault, "good.md", ID1); // indexable
    // opted-in (has context) but no id
    writeFileSync(
      join(vault, "no-id.md"),
      "---\ncontext: homelab\ncreated: 2026-01-01\n---\nbody\n",
    );
    // opted-in but no parseable date
    writeFileSync(join(vault, "no-date.md"), `---\nid: ${ID2}\ncontext: homelab\n---\nbody\n`);
    // true opt-out (no context/source) — silently ignored, not an on_skip event
    writeFileSync(join(vault, "opt-out.md"), "---\ntitle: just a note\n---\nbody\n");

    const skips: [string, string][] = [];
    const progress: [number, number, string | null][] = [];
    const stats = ingestVault(conn, cfg, {
      onSkip: (p, r) => skips.push([basename(p), r]),
      onProgress: (done, total, current) => progress.push([done, total, current]),
    });

    const reasons = Object.fromEntries(skips);
    expect(reasons).toEqual({ "no-id.md": "no id", "no-date.md": "no date" });
    expect(stats.indexed).toBe(1);
    expect(progress.at(-1)).toEqual([4, 4, null]); // advanced to completion
    expect(progress.some(([, , cur]) => cur === "good.md")).toBe(true);
  });

  it("the structural pass leaves zero vectors and a BM25-ready index", () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2, { body: "Another note body about proxies." });
    const stats = ingestVault(conn, cfg); // structural only, no provider
    expect(stats.indexed).toBe(2);

    const s = new Storage(conn);
    const st = s.stats();
    expect(st.chunks).toBeGreaterThanOrEqual(2);
    expect(st.vectors).toBe(0); // no vectors yet
    expect(s.pendingChunks().length).toBe(st.chunks); // everything pending
    expect((conn.prepare("SELECT COUNT(*) c FROM documents_fts").get() as { c: number }).c).toBe(2);

    // sanity: FakeProvider isn't wired into the structural path at all
    void FakeProvider;
  });
});
