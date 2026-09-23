import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { describeRun, reindexOnce, startWatch } from "../src/ingest/watch.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";

// Service readiness (#22): WAL lets a writer and a reader share one DB file,
// and the watch loop keeps the index in step with the vault.

const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";

function makeCfg(tmpPath: string): Config {
  const vault = join(tmpPath, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
  cfg.vaultPath = vault;
  cfg.dbPath = join(tmpPath, "qkb.db");
  cfg.embeddingProvider = "fake";
  cfg.embeddingDim = 8;
  return cfg;
}

function writeNote(cfg: Config, name: string, id: string, body: string): void {
  writeFileSync(
    join(cfg.vaultPath, name),
    `---\nid: ${id}\ncontext: homelab-traefik\ncreated: 2026-01-01\n---\n\n${body}\n`,
  );
}

describe("SQLite concurrency", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-wal-"));
  });

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("opens file databases in WAL mode with a busy timeout", () => {
    const conn = connect(join(tmpPath, "qkb.db"), 8);
    expect(conn.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(conn.pragma("busy_timeout", { simple: true })).toBe(5000);
    conn.close();
  });

  it("a reader keeps reading while a writer holds an open write transaction", () => {
    const cfg = makeCfg(tmpPath);
    const writer = connect(cfg.dbPath, 8);
    const reader = connect(cfg.dbPath, 8);
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare(
        "INSERT INTO documents (id, type, effective_date, created_at, file_path, content_hash) " +
          "VALUES ('x', 'note', '2026-01-01', '2026-01-01', 'x.md', 'h')",
      )
      .run();
    // Without WAL this SELECT would block/fail on the writer's lock.
    expect((reader.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
    writer.exec("COMMIT");
    expect((reader.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(1);
    writer.close();
    reader.close();
  });
});

describe("watch loop", () => {
  let tmpPath: string;
  let cfg: Config;

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-watch-"));
    cfg = makeCfg(tmpPath);
  });

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("reindexOnce ingests and embeds, so the note is vector-searchable", async () => {
    writeNote(cfg, "a.md", ID1, "Renewing traefik certificates.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const provider = new FakeProvider(cfg.embeddingDim);
    const r = await reindexOnce(conn, cfg, provider);
    expect(r.stats.indexed).toBe(1);
    expect(r.embedded).toBeGreaterThan(0);
    expect(new Storage(conn).pendingChunks()).toEqual([]);
    const hits = await executeSearch(conn, cfg, provider, "traefik", new Filters(), null, "vector");
    expect(hits[0]?.document_id).toBe(ID1);
    conn.close();
  });

  it("picks up an added, an edited and a deleted note across runs", async () => {
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const provider = new FakeProvider(cfg.embeddingDim);
    const watcher = startWatch(conn, cfg, provider, { intervalSec: 3600, runOnStart: false });

    writeNote(cfg, "a.md", ID1, "Renewing traefik certificates.");
    const added = await watcher.runNow();
    expect(added?.stats.indexed).toBe(1);

    writeNote(cfg, "a.md", ID1, "Renewing traefik certificates, now with DNS challenge.");
    writeNote(cfg, "b.md", ID2, "Unrelated note.");
    const edited = await watcher.runNow();
    expect(edited?.stats.updated).toBe(1);
    expect(edited?.stats.indexed).toBe(1);

    unlinkSync(join(cfg.vaultPath, "b.md"));
    const deleted = await watcher.runNow();
    expect(deleted?.stats.deindexed).toBe(1);

    const idle = await watcher.runNow();
    expect(idle && describeRun(idle)).toBeNull();

    await watcher.stop();
    conn.close();
  });

  it("runNow joins a pass already in flight instead of overlapping it", async () => {
    writeNote(cfg, "a.md", ID1, "Renewing traefik certificates.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const watcher = startWatch(conn, cfg, null, { intervalSec: 3600, runOnStart: false });
    const [a, b] = [watcher.runNow(), watcher.runNow()];
    expect(a).toBe(b);
    await a;
    await watcher.stop();
    conn.close();
  });

  it("a failing pass is reported and the loop keeps running", async () => {
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const errors: unknown[] = [];
    const broken = { ...cfg, vaultPath: join(tmpPath, "missing-vault") };
    const watcher = startWatch(conn, broken, null, {
      intervalSec: 3600,
      runOnStart: false,
      onError: (e) => errors.push(e),
    });
    expect(await watcher.runNow()).toBeNull();
    expect(errors).toHaveLength(1);

    // The vault comes back (e.g. a mount reappears): the next pass succeeds.
    mkdirSync(broken.vaultPath, { recursive: true });
    writeFileSync(
      join(broken.vaultPath, "a.md"),
      `---\nid: ${ID1}\ncontext: homelab\ncreated: 2026-01-01\n---\n\nBack.\n`,
    );
    expect((await watcher.runNow())?.stats.indexed).toBe(1);
    await watcher.stop();
    conn.close();
  });

  it("re-runs on its own timer", async () => {
    writeNote(cfg, "a.md", ID1, "Renewing traefik certificates.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    let runs = 0;
    const watcher = startWatch(conn, cfg, null, {
      intervalSec: 0.02,
      onRun: () => {
        runs++;
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    conn.close();
  });
});
