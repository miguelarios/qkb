import { randomUUID } from "node:crypto";
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
import type { EmbeddingProvider } from "../src/embed/types.js";
import { embedPending, ingestVault } from "../src/ingest/pipeline.js";

// Ports the STRUCTURAL cases of legacy/python/tests/test_pipeline.py — the
// provider=None path of ingest_vault (chunks stored without vectors). The
// provider-inline / sentinel / --full-reembed cases and the embed_pending
// cases belong to Task 9 and are intentionally not ported here.

/** A FakeProvider under a different model name — mirrors the dynamic
 * subclassing trick in test_pipeline.py's model-switch tests. */
class NamedFakeProvider extends FakeProvider {
  constructor(
    dimension: number,
    private readonly name: string,
  ) {
    super(dimension);
  }

  override get modelName(): string {
    return this.name;
  }
}

/** FakeProvider under a different model name that fails after N embed()
 * calls, simulating an Ollama crash / Ctrl-C partway through a --full
 * re-embed or a batched `qkb embed` run. Ports test_pipeline.py's
 * `_ExplodingProvider`. */
class ExplodingProvider extends FakeProvider {
  private calls = 0;

  constructor(
    dimension: number,
    private readonly name: string,
    private readonly failAfter: number,
  ) {
    super(dimension);
  }

  override get modelName(): string {
    return this.name;
  }

  override async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.calls > this.failAfter) {
      throw new Error("simulated interruption");
    }
    return super.embed(texts);
  }
}

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

  it("indexes new, then unchanged, then updated", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    let stats = await ingestVault(conn, cfg);
    expect(stats.indexed).toBe(2);
    expect(stats.scanned).toBeGreaterThanOrEqual(2);

    stats = await ingestVault(conn, cfg); // no changes
    expect(stats.unchanged).toBe(2);
    expect(stats.indexed).toBe(0);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" }); // content change
    stats = await ingestVault(conn, cfg);
    expect(stats.updated).toBe(1);
    expect(stats.unchanged).toBe(1);
  });

  it("--full re-indexes every note, ignoring the content-hash fast path", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg);

    // Nothing changed on disk, but --full must re-chunk/re-upsert both notes
    // (counted as indexed, since their stored hash is non-null) instead of
    // taking the unchanged fast path.
    const stats = await ingestVault(conn, cfg, { full: true });
    expect(stats.indexed).toBe(2);
    expect(stats.unchanged).toBe(0);
    expect(stats.updated).toBe(0);
    // still structural: no vectors written by --full on the provider-less path
    expect(new Storage(conn).stats().vectors).toBe(0);
  });

  it("de-indexes an opt-out and a genuine file deletion", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    await ingestVault(conn, cfg);

    // opt out: rewrite without context/source
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nx\n`,
    );
    // deletion: remove b.md entirely
    unlinkSync(join(vault, "b.md"));
    const stats = await ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(2);
    expect((conn.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
  });

  it("is a true no-op on an unchanged re-ingest (no writes, indexed_at frozen)", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg);
    const lastBefore = (
      conn.prepare("SELECT MAX(indexed_at) m FROM documents").get() as { m: string }
    ).m;
    const changesBefore = totalChanges(conn);

    const stats = await ingestVault(conn, cfg);

    expect(stats.unchanged).toBe(2);
    expect(stats.indexed).toBe(0);
    expect(stats.updated).toBe(0);
    expect(totalChanges(conn)).toBe(changesBefore); // no writes at all
    const lastAfter = (
      conn.prepare("SELECT MAX(indexed_at) m FROM documents").get() as { m: string }
    ).m;
    expect(lastAfter).toBe(lastBefore);
  });

  it("applies a frontmatter-only change without a full re-index", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg);

    writeNote(vault, "a.md", ID1, { context: "homelab-updated" }); // same body, new context
    const stats = await ingestVault(conn, cfg);

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

  it("a body change still triggers a full re-index", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" });
    const stats = await ingestVault(conn, cfg);

    expect(stats.updated).toBe(1);
    expect(stats.unchanged).toBe(0);
    const body = (
      conn.prepare("SELECT body FROM documents_fts WHERE doc_id = ?").get(ID1) as { body: string }
    ).body;
    expect(body).toContain("Edited body!");
  });

  it("a pure rename refreshes documents.file_path via the fast path", async () => {
    writeNote(vault, "old-name.md", ID1, { extra: "title: Stable Title\n" });
    await ingestVault(conn, cfg);
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
    const stats = await ingestVault(conn, cfg);

    expect(stats.unchanged).toBe(1); // body unchanged, still the fast path
    expect(
      (
        conn.prepare("SELECT file_path FROM documents WHERE id = ?").get(ID1) as {
          file_path: string;
        }
      ).file_path,
    ).toBe("new-name.md");
  });

  it("a reserved-metadata-key note does not crash the run", async () => {
    writeNote(vault, "evil.md", ID1, { extra: "__qkb_meta_hash__: evil\n" });

    const stats = await ingestVault(conn, cfg); // must not throw

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

  it("protection: parse exception on a still-present file does not de-index it", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    await ingestVault(conn, cfg);

    // a.md: mid-edit save with malformed YAML frontmatter (parse raises)
    writeFileSync(join(vault, "a.md"), "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n");
    // b.md: genuinely deleted
    unlinkSync(join(vault, "b.md"));

    const stats = await ingestVault(conn, cfg);

    expect(stats.deindexed).toBe(1); // only the genuinely-deleted b.md
    expect(stats.skipped).toBeGreaterThanOrEqual(1); // a.md counted, not dropped
    expect(docCount(conn, ID1)).toBe(1); // a.md's rows intact
    expect(ftsCount(conn, ID1)).toBe(1);
    expect(docCount(conn, ID2)).toBe(0); // b.md fully gone
  });

  it("protection: an opted-in note becoming date-unparseable is protected, then a genuine opt-out de-indexes", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2);
    await ingestVault(conn, cfg);

    // a.md: still opted in, valid YAML, but its only date is a Templater
    // placeholder that doesn't parse -> parseNote raises NoteDataError.
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncontext: homelab\ncreated: <% tp.date.now() %>\n---\n\nstill here\n`,
    );

    let stats = await ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);
    expect(ftsCount(conn, ID1)).toBe(1);

    // But a genuine opt-out (remove context AND source) still de-indexes.
    writeFileSync(
      join(vault, "a.md"),
      `---\nid: ${ID1}\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nno longer indexable\n`,
    );
    stats = await ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(1);
    expect(docCount(conn, ID1)).toBe(0);
  });

  it("protection: a brand-new unindexable opted-in file is skipped, not crashed", async () => {
    writeFileSync(
      join(vault, "broken.md"),
      `---\nid: ${ID1}\ncontext: homelab\nsource: somewhere\ndate: <% tp.date.now() %>\n---\n\nx\n`,
    );

    const stats = await ingestVault(conn, cfg);

    expect(stats.indexed).toBe(0);
    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect((conn.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
  });

  it("duplicate frontmatter id: first sorted wins, duplicate is reported, no ping-pong", async () => {
    writeNote(vault, "a.md", ID1, { body: "First body." });
    writeNote(vault, "z-dup.md", ID1, { body: "Second body claiming the same id." });

    const skips: [string, string][] = [];
    const stats = await ingestVault(conn, cfg, {
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
    const stats2 = await ingestVault(conn, cfg);
    expect(stats2.indexed).toBe(0);
    expect(stats2.updated).toBe(0);
    expect(stats2.unchanged).toBe(1);
    expect(stats2.skipped).toBeGreaterThanOrEqual(1);
  });

  it("protection: a renamed note that also fails to parse is not de-indexed", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg);

    unlinkSync(join(vault, "a.md"));
    writeFileSync(
      join(vault, "renamed.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const stats = await ingestVault(conn, cfg);

    expect(stats.deindexed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);
  });

  it("trade-off: an unrelated deletion is deferred during an unresolved parse failure, then self-heals", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "unrelated/b.md", ID2, { body: "Unrelated note body." });
    await ingestVault(conn, cfg);

    // Run 2: delete a.md AND add an unrelated new file at a never-seen path
    // with malformed frontmatter (unresolved parse failure).
    unlinkSync(join(vault, "a.md"));
    writeFileSync(
      join(vault, "new-broken.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const stats = await ingestVault(conn, cfg);
    expect(stats.deindexed).toBe(0); // a.md's deletion is deferred
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(docCount(conn, ID1)).toBe(1);

    // Run 3: parse-clean (remove the malformed file); a.md is still gone.
    unlinkSync(join(vault, "new-broken.md"));
    const stats2 = await ingestVault(conn, cfg);
    expect(stats2.deindexed).toBe(1); // now it de-indexes
    expect(docCount(conn, ID1)).toBe(0);
  });

  it("the single-scan sweep still de-indexes a pure deletion alongside an update", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    const stats = await ingestVault(conn, cfg);
    expect(stats.indexed).toBe(2);

    writeNote(vault, "a.md", ID1, { body: "Edited body!" }); // update
    unlinkSync(join(vault, "sub/b.md")); // genuine deletion, no parse failures

    const stats2 = await ingestVault(conn, cfg);

    expect(stats2.updated).toBe(1);
    expect(stats2.deindexed).toBe(1);
    expect(docCount(conn, ID2)).toBe(0);
    expect(docCount(conn, ID1)).toBe(1);
  });

  it("an all-unchanged re-ingest uses batched metadata hashes (no per-doc getMetadataHash)", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg);

    const spy = vi.spyOn(Storage.prototype, "getMetadataHash");
    const stats = await ingestVault(conn, cfg);

    expect(spy).not.toHaveBeenCalled();
    expect(stats.unchanged).toBe(2);
    spy.mockRestore();
  });

  it("reports categorized skip reasons and drives progress to completion", async () => {
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
    const stats = await ingestVault(conn, cfg, {
      onSkip: (p, r) => skips.push([basename(p), r]),
      onProgress: (done, total, current) => progress.push([done, total, current]),
    });

    const reasons = Object.fromEntries(skips);
    expect(reasons).toEqual({ "no-id.md": "no id", "no-date.md": "no date" });
    expect(stats.indexed).toBe(1);
    expect(progress.at(-1)).toEqual([4, 4, null]); // advanced to completion
    expect(progress.some(([, , cur]) => cur === "good.md")).toBe(true);
  });

  it("the structural pass leaves zero vectors and a BM25-ready index", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2, { body: "Another note body about proxies." });
    const stats = await ingestVault(conn, cfg); // structural only, no provider
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

// Ports the provider-path / inline-embed cases of test_pipeline.py that Task 8
// deferred (ingest_vault(provider=...)), plus embed_pending — the resumable
// second phase driven by `qkb embed`.
describe("ingest/pipeline (provider path + embedPending)", () => {
  let conn: Database.Database;
  let vault: string;
  let cfg: Config;
  let provider: FakeProvider;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    vault = mkdtempSync(join(tmpdir(), "qkb-vault-"));
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian", "ignore-me.md"), "no frontmatter");
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = vault;
    provider = new FakeProvider(DIM);
  });

  afterEach(() => {
    conn.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("requires --full after a model switch", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg, { provider });

    const other = new NamedFakeProvider(DIM, "different-model");
    await expect(ingestVault(conn, cfg, { provider: other })).rejects.toThrow(/--full/);

    const stats = await ingestVault(conn, cfg, { provider: other, full: true });
    expect(stats.indexed).toBe(1);
  });

  it("a --full re-embed across a dimension change rebuilds the vector index", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider }); // indexed at dim=8

    const wider = new FakeProvider(16);
    const stats = await ingestVault(conn, cfg, { provider: wider, full: true }); // must not throw a dim-mismatch error
    expect(stats.indexed).toBe(2);

    const chunkCount = (conn.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    const vecCount = (conn.prepare("SELECT COUNT(*) c FROM chunks_vec").get() as { c: number }).c;
    expect(chunkCount).toBeGreaterThan(0);
    expect(vecCount).toBe(chunkCount);

    const qvec = await wider.embedQuery("Another note body");
    const row = conn
      .prepare("SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1")
      .get(new Float32Array(qvec)) as { chunk_id: number; distance: number } | undefined;
    expect(row).toBeDefined();
  });

  it("an interrupted --full re-embed does not commit the new model", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider }); // committed as fake-8d

    const modelB = new ExplodingProvider(DIM, "model-b", 1);
    await expect(ingestVault(conn, cfg, { provider: modelB, full: true })).rejects.toThrow(
      /simulated interruption/,
    );

    // the interrupted full run must not have committed model-b as current
    await expect(ingestVault(conn, cfg, { provider: modelB, full: false })).rejects.toThrow(
      /--full/,
    );
  });

  it("an interrupted --full re-embed (same model) still blocks the next plain ingest", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider }); // committed as fake-8d

    const sameModel = new ExplodingProvider(DIM, provider.modelName, 1);
    await expect(ingestVault(conn, cfg, { provider: sameModel, full: true })).rejects.toThrow(
      /simulated interruption/,
    );

    // a subsequent plain ingest — even with the original, non-exploding
    // provider, whose model/dim still matches embedding_config — must refuse
    // until --full completes.
    await expect(ingestVault(conn, cfg, { provider, full: false })).rejects.toThrow(/--full/);
  });

  it("a --full re-embed after interruption recovers and clears the sentinel", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider });

    const sameModel = new ExplodingProvider(DIM, provider.modelName, 1);
    await expect(ingestVault(conn, cfg, { provider: sameModel, full: true })).rejects.toThrow(
      /simulated interruption/,
    );

    const stats = await ingestVault(conn, cfg, { provider, full: true }); // recovery run must succeed
    expect(stats.indexed).toBe(2);

    const stats2 = await ingestVault(conn, cfg, { provider, full: false }); // sentinel cleared
    expect(stats2.unchanged).toBe(2);
  });

  it("a clean --full re-embed leaves the sentinel cleared", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg, { provider });

    const stats = await ingestVault(conn, cfg, { provider, full: true });
    expect(stats.indexed).toBe(1);

    const stats2 = await ingestVault(conn, cfg, { provider, full: false });
    expect(stats2.unchanged).toBe(1);
  });

  it("a --full at the same dimension does not wipe vectors for a protected doc", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider });

    const bChunkIds = (
      conn.prepare("SELECT id FROM chunks WHERE document_id = ?").all(ID2) as { id: number }[]
    ).map((r) => r.id);
    expect(bChunkIds.length).toBeGreaterThan(0);
    const marks = bChunkIds.map(() => "?").join(",");
    const vecCountBefore = (
      conn
        .prepare(`SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN (${marks})`)
        .get(...bChunkIds) as { c: number }
    ).c;
    expect(vecCountBefore).toBe(bChunkIds.length);

    writeFileSync(
      join(vault, "sub/b.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const stats = await ingestVault(conn, cfg, { provider, full: true }); // same dimension (8)
    expect(stats.deindexed).toBe(0);

    const vecCountAfter = (
      conn
        .prepare(`SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN (${marks})`)
        .get(...bChunkIds) as { c: number }
    ).c;
    expect(vecCountAfter).toBe(vecCountBefore);
  });

  it("a --full dimension change clears content_hash for a protected doc, which later re-embeds", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    await ingestVault(conn, cfg, { provider }); // dim=8

    writeFileSync(
      join(vault, "sub/b.md"),
      "---\nid: [unterminated\ncontext: homelab\n---\n\nbody\n",
    );

    const wider = new FakeProvider(16);
    const stats = await ingestVault(conn, cfg, { provider: wider, full: true }); // dim change -> wipes table
    expect(stats.deindexed).toBe(0);

    const row = conn.prepare("SELECT content_hash FROM documents WHERE id = ?").get(ID2) as {
      content_hash: string;
    };
    expect(row.content_hash).toBe("");

    // fix b.md and run a plain ingest with the now-current (wider) provider
    writeNote(vault, "sub/b.md", ID2, { body: "Another note body." });
    cfg.embeddingDim = 16;
    const stats2 = await ingestVault(conn, cfg, { provider: wider, full: false });

    expect(stats2.updated).toBe(1); // stored hash was '' (not null), so this is the update path
    const bChunkIds = (
      conn.prepare("SELECT id FROM chunks WHERE document_id = ?").all(ID2) as { id: number }[]
    ).map((r) => r.id);
    expect(bChunkIds.length).toBeGreaterThan(0);
    const marks = bChunkIds.map(() => "?").join(",");
    const vecCount = (
      conn
        .prepare(`SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id IN (${marks})`)
        .get(...bChunkIds) as { c: number }
    ).c;
    expect(vecCount).toBe(bChunkIds.length);
    const row2 = conn.prepare("SELECT content_hash FROM documents WHERE id = ?").get(ID2) as {
      content_hash: string;
    };
    expect(row2.content_hash).not.toBe("");
  });

  // ----------------------------- embedPending -----------------------------

  it("embedPending fills vectors for a structural ingest and commits the config", async () => {
    writeNote(vault, "a.md", ID1);
    writeNote(vault, "b.md", ID2, { body: "Another note body about proxies." });
    const stats = await ingestVault(conn, cfg); // structural only
    expect(stats.indexed).toBe(2);

    const s = new Storage(conn);
    const st = s.stats();
    expect(st.chunks).toBeGreaterThanOrEqual(2);
    expect(st.vectors).toBe(0);
    expect(s.pendingChunks().length).toBe(st.chunks);
    expect((conn.prepare("SELECT COUNT(*) c FROM documents_fts").get() as { c: number }).c).toBe(2);

    const n = await embedPending(conn, cfg, provider); // second phase
    expect(n).toBe(st.chunks);
    expect(s.stats().vectors).toBe(st.chunks);
    expect(s.pendingChunks()).toEqual([]);
    expect(s.storedEmbeddingConfig()).toEqual(["fake-8d", 8]); // embed commits the model/dim
  });

  it("embedPending is incremental — only new pending chunks are embedded", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg);
    expect(await embedPending(conn, cfg, provider)).toBeGreaterThanOrEqual(1);
    expect(await embedPending(conn, cfg, provider)).toBe(0); // nothing pending

    writeNote(vault, "a.md", ID1, { body: `Edited and now much longer body. ${"x".repeat(20)}` });
    await ingestVault(conn, cfg); // re-chunks a.md -> new pending chunks
    const s = new Storage(conn);
    expect(s.pendingChunks().length).toBeGreaterThanOrEqual(1);
    await embedPending(conn, cfg, provider); // embeds only the new ones
    expect(s.pendingChunks()).toEqual([]);
  });

  it("embedPending rejects a model change without --full", async () => {
    writeNote(vault, "a.md", ID1);
    await ingestVault(conn, cfg);
    await embedPending(conn, cfg, provider); // commits fake-8d

    const other = new NamedFakeProvider(DIM, "other-model");
    await expect(embedPending(conn, cfg, other)).rejects.toThrow(/--full/);

    const n = await embedPending(conn, cfg, other, { full: true }); // re-embeds under the new model
    const s = new Storage(conn);
    expect(n).toBe(s.stats().chunks);
    expect(s.storedEmbeddingConfig()).toEqual(["other-model", 8]);
  });

  it("embedPending batches in groups of 64 by default", async () => {
    for (let i = 0; i < 70; i++) {
      writeNote(vault, `note-${i}.md`, randomUUID(), { body: `Body number ${i}.` });
    }
    await ingestVault(conn, cfg);
    const s = new Storage(conn);
    const totalPending = s.pendingChunks().length;
    expect(totalPending).toBeGreaterThanOrEqual(70);

    const batchSizes: number[] = [];
    const recordingProvider: EmbeddingProvider = {
      dimension: DIM,
      modelName: "fake-8d",
      async embed(texts) {
        batchSizes.push(texts.length);
        return provider.embed(texts);
      },
      async embedQuery(q) {
        return provider.embedQuery(q);
      },
    };

    const n = await embedPending(conn, cfg, recordingProvider);
    expect(n).toBe(totalPending);
    expect(batchSizes[0]).toBe(64);
    expect(batchSizes.every((size) => size <= 64)).toBe(true);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(totalPending);
  });

  it("a mid-batch throw during embedPending leaves earlier batches committed (resumable)", async () => {
    // Real, file-backed DB (not :memory:) so we can close and reopen a fresh
    // connection to prove the earlier batches' commits actually persisted,
    // rather than merely surviving on the same in-process connection.
    const dbDir = mkdtempSync(join(tmpdir(), "qkb-db-"));
    const dbPath = join(dbDir, "qkb.db");
    const fileConn = connect(dbPath, DIM);
    try {
      const fileVault = mkdtempSync(join(tmpdir(), "qkb-vault2-"));
      try {
        const fileCfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
        fileCfg.vaultPath = fileVault;

        for (let i = 0; i < 10; i++) {
          writeNote(fileVault, `note-${i}.md`, randomUUID(), { body: `Body ${i}.` });
        }
        await ingestVault(fileConn, fileCfg);
        const totalPending = new Storage(fileConn).pendingChunks().length;
        expect(totalPending).toBeGreaterThanOrEqual(10);

        // Fails on the 2nd batch call — batchSize 3 guarantees several batches.
        const exploding = new ExplodingProvider(DIM, "fake-8d", 1);
        await expect(embedPending(fileConn, fileCfg, exploding, { batchSize: 3 })).rejects.toThrow(
          /simulated interruption/,
        );

        const vectorsAfterCrash = new Storage(fileConn).stats().vectors;
        expect(vectorsAfterCrash).toBe(3); // exactly the first (committed) batch
        expect(vectorsAfterCrash).toBeLessThan(totalPending);
      } finally {
        rmSync(fileVault, { recursive: true, force: true });
      }
    } finally {
      fileConn.close();
    }

    // Reopen a fresh connection against the same file — proves durability,
    // not just same-process/same-connection state.
    const resumedConn = connect(dbPath, DIM);
    try {
      const resumedCfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
      const storage = new Storage(resumedConn);
      const remaining = storage.pendingChunks().length;
      expect(remaining).toBeGreaterThan(0);

      const workingProvider = new FakeProvider(DIM);
      const n = await embedPending(resumedConn, resumedCfg, workingProvider, { batchSize: 3 });

      expect(n).toBe(remaining); // resumed run only embeds what was left
      expect(storage.pendingChunks()).toEqual([]);
    } finally {
      resumedConn.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
