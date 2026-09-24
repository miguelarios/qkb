import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { parseNote } from "../src/ingest/parser.js";
import { embedPending, ingestVault } from "../src/ingest/pipeline.js";
import { Filters } from "../src/search/filters.js";
import { getDocument } from "../src/search/retrieval.js";
import { executeSearch } from "../src/search/service.js";
import { buildServer } from "../src/server/mcp.js";
import { embeddingText, renderFields } from "../src/types.js";

// Declared extra properties (#24): `[frontmatter.fields]` keys are searched,
// embedded, returned, filterable, and described to agents.

const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";

function writeNote(vault: string, name: string, id: string, extra: string, body: string): string {
  const p = join(vault, name);
  writeFileSync(p, `---\nid: ${id}\ncontext: work\ncreated: 2026-01-01\n${extra}---\n\n${body}\n`);
  return p;
}

/** A provider that records every text it embeds. */
class RecordingProvider extends FakeProvider {
  seen: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.seen.push(...texts);
    return super.embed(texts);
  }
}

describe("declared frontmatter fields", () => {
  let tmp: string;
  let cfg: Config;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-fields-"));
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = join(tmp, "vault");
    mkdirSync(cfg.vaultPath);
    cfg.dbPath = join(tmp, "qkb.db");
    cfg.embeddingProvider = "fake";
    cfg.embeddingDim = 8;
    cfg.fields = { project: "Project this note belongs to", attendees: "People present" };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parser keeps declared keys (in declaration order) apart from other extras", () => {
    const p = writeNote(
      cfg.vaultPath,
      "a.md",
      ID1,
      "attendees:\n  - Alice Smith\n  - Bob Jones\nproject: Apollo\nstatus: draft\n",
      "Body.",
    );
    const n = parseNote(p, cfg.vaultPath, cfg.frontmatter, Object.keys(cfg.fields));
    expect(n?.fields).toEqual({ project: "Apollo", attendees: "Alice Smith, Bob Jones" });
    expect(n?.extraMetadata.status).toBe("draft");
    expect(Object.keys(n?.fields ?? {})).toEqual(["project", "attendees"]);
  });

  it("declared values are keyword-searchable, returned, and filterable", async () => {
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\n", "Weekly sync notes.");
    writeNote(cfg.vaultPath, "b.md", ID2, "project: Borealis\nstatus: Apollo\n", "Other notes.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(8) });

    // "Apollo" appears only as a declared value on ID1 (ID2 has it in an
    // UNdeclared key, which must not rank).
    const hits = await executeSearch(conn, cfg, null, "apollo", new Filters(), null, "bm25");
    expect(hits.map((h) => h.document_id)).toEqual([ID1]);
    expect(hits[0]?.fields).toEqual({ project: "Apollo" });

    const filtered = await executeSearch(
      conn,
      cfg,
      null,
      "notes",
      new Filters({ fields: { project: "borealis" } }),
      null,
      "bm25",
    );
    expect(filtered.map((h) => h.document_id)).toEqual([ID2]);
    conn.close();
  });

  it("a list value matches one of its items", async () => {
    writeNote(
      cfg.vaultPath,
      "a.md",
      ID1,
      "attendees:\n  - Alice Smith\n  - Bob Jones\n",
      "Meeting notes.",
    );
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    const run = (who: string) =>
      executeSearch(
        conn,
        cfg,
        null,
        "meeting",
        new Filters({ fields: { attendees: who } }),
        null,
        "bm25",
      );
    expect(await run("bob jones")).toHaveLength(1);
    expect(await run("Alice Smith, Bob Jones")).toHaveLength(1);
    expect(await run("bob")).toHaveLength(0);
    conn.close();
  });

  it("declared fields are part of every chunk's embedded text", async () => {
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\n", "Weekly sync notes.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const inline = new RecordingProvider(8);
    await ingestVault(conn, cfg, { provider: inline });
    expect(inline.seen[0]).toBe(embeddingText("project: Apollo", "Weekly sync notes."));

    // The two-phase path (ingest, then embed) embeds the same text.
    const conn2 = connect(join(tmp, "two-phase.db"), 8);
    await ingestVault(conn2, cfg);
    const later = new RecordingProvider(8);
    await embedPending(conn2, cfg, later);
    expect(later.seen).toEqual(inline.seen);
    conn.close();
    conn2.close();
  });

  it("changing a declared value re-embeds only that note", async () => {
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\n", "Weekly sync notes.");
    writeNote(cfg.vaultPath, "b.md", ID2, "project: Borealis\n", "Other notes.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    await embedPending(conn, cfg, new FakeProvider(8));
    expect(new Storage(conn).pendingChunks()).toEqual([]);

    writeNote(cfg.vaultPath, "a.md", ID1, "project: Artemis\n", "Weekly sync notes.");
    const stats = await ingestVault(conn, cfg);
    expect(stats.unchanged).toBe(2); // body unchanged — no re-chunk
    const pending = new Storage(conn).pendingChunks();
    expect(pending.map(([, t]) => t)).toEqual([
      embeddingText("project: Artemis", "Weekly sync notes."),
    ]);
    conn.close();
  });

  it("declaring a new field refreshes existing notes on the next ingest", async () => {
    cfg.fields = {};
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\n", "Weekly sync notes.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    await embedPending(conn, cfg, new FakeProvider(8));
    expect(await executeSearch(conn, cfg, null, "apollo", new Filters(), null, "bm25")).toEqual([]);

    cfg.fields = { project: "Project" };
    await ingestVault(conn, cfg);
    const hits = await executeSearch(conn, cfg, null, "apollo", new Filters(), null, "bm25");
    expect(hits.map((h) => h.document_id)).toEqual([ID1]);
    expect(new Storage(conn).pendingChunks()).toHaveLength(1);
    conn.close();
  });

  it("qkb get returns declared fields and every other stored property", async () => {
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\nstatus: draft\n", "Body.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    const doc = getDocument(conn, ID1);
    expect(doc.fields).toEqual({ project: "Apollo" });
    // context is an ordinary stored property now (#35)
    expect(doc.metadata).toEqual({ context: "work", project: "Apollo", status: "draft" });
    conn.close();
  });

  it("the MCP tools describe declared fields and accept a fields filter", async () => {
    writeNote(cfg.vaultPath, "a.md", ID1, "project: Apollo\n", "Weekly sync notes.");
    writeNote(cfg.vaultPath, "b.md", ID2, "project: Borealis\n", "Weekly sync notes.");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(8) });
    conn.close();

    const server = await buildServer(cfg);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    const qkb = tools.find((t) => t.name === "qkb");
    expect(qkb?.description).toContain("project (Project this note belongs to)");

    const res = await client.callTool({
      name: "qkb",
      arguments: { query: "weekly sync", fields: { project: "Apollo" } },
    });
    const out = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
    expect(out.result.map((r: { document_id: string }) => r.document_id)).toEqual([ID1]);

    const statusRes = await client.callTool({ name: "qkb_status", arguments: {} });
    const status = JSON.parse((statusRes.content as { text: string }[])[0]?.text ?? "{}");
    expect(status.fields).toEqual(cfg.fields);
    await client.close();
  });

  it("renderFields flattens multi-line values to one line per field", () => {
    expect(renderFields({ a: "one\n  two", b: "x" })).toBe("a: one two\nb: x");
  });
});

describe("[frontmatter.fields] config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-fieldcfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads declared fields with descriptions", () => {
    const p = join(tmp, "c.toml");
    writeFileSync(p, '[frontmatter.fields]\nproject = "Project"\nattendees = "People"\n');
    expect(loadConfig(p, {}).fields).toEqual({ project: "Project", attendees: "People" });
  });

  it("rejects declaring a core key or alias as an extra field", () => {
    const p = join(tmp, "c.toml");
    writeFileSync(p, '[frontmatter.fields]\n"date created" = "dup"\n');
    expect(() => loadConfig(p, {})).toThrow(/already a core frontmatter key/);
  });
});

describe("schema reset for an index built by an older qkb", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-migrate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resets a v0.5 index on open (with a notice), then leaves the new one alone", () => {
    const path = join(tmp, "old.db");
    // The v0.5.x layout: no meta table, context/source columns.
    const old = new Database(path);
    sqliteVec.load(old);
    old.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, context TEXT, source TEXT,
        effective_date TEXT NOT NULL, created_at TEXT NOT NULL, file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL, title TEXT, vault_name TEXT NOT NULL DEFAULT 'Notes');
      CREATE TABLE context_descriptions (context TEXT PRIMARY KEY, description TEXT NOT NULL);
      INSERT INTO documents (id, type, effective_date, created_at, file_path, content_hash)
        VALUES ('${ID1}', 'note', '2026-01-01', '2026-01-01', 'a.md', 'h');
    `);
    old.close();

    const notices: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: string) => {
      notices.push(m);
    });
    try {
      const conn = connect(path, 8);
      expect(notices.join("\n")).toMatch(/index format changed \(v1 → v2\).*reset/s);
      expect((conn.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c).toBe(0);
      const cols = (conn.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).not.toContain("context");
      expect(
        conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'context_descriptions'").get(),
      ).toBeUndefined();
      conn.close();

      notices.length = 0;
      connect(path, 8).close();
      expect(notices).toEqual([]); // current version: no second reset
    } finally {
      spy.mockRestore();
    }
  });
});
