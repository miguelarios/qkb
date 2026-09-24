import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";

// Built-in ranking signals (#34): short, deliberate text — title, aliases,
// headings — outranks the same word buried in body text.

describe("title, aliases and headings as ranking signals", () => {
  let tmp: string;
  let cfg: Config;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-rank-"));
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = join(tmp, "vault");
    mkdirSync(cfg.vaultPath);
    cfg.dbPath = join(tmp, "qkb.db");
    cfg.embeddingProvider = "fake";
    cfg.embeddingDim = 8;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function note(name: string, id: string, frontmatter: string, body: string): void {
    writeFileSync(join(cfg.vaultPath, name), `---\nid: ${id}\n${frontmatter}---\n\n${body}\n`);
  }

  async function top(query: string): Promise<string[]> {
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    const hits = await executeSearch(conn, cfg, null, query, new Filters(), null, "bm25");
    conn.close();
    return hits.map((h) => h.document_id);
  }

  // Filler keeps the body-only note's text the same length as the others,
  // so body-length normalization can't decide the order.
  const FILLER = "Notes about the weekly planning session and follow-ups.";

  it("an alias match outranks a body-only match", async () => {
    note("body.md", "body", "", `${FILLER} We discussed zephyr briefly.`);
    note("alias.md", "alias", "aliases: [Zephyr]\n", FILLER);
    expect(await top("zephyr")).toEqual(["alias", "body"]);
  });

  it("a heading match outranks a body-only match", async () => {
    note("body.md", "body", "", `${FILLER} We discussed zephyr briefly.`);
    note("heading.md", "heading", "", `## Zephyr\n\n${FILLER}`);
    expect(await top("zephyr")).toEqual(["heading", "body"]);
  });

  it("a title match (including the file-name fallback) outranks a body-only match", async () => {
    note("body.md", "body", "", `${FILLER} We discussed zephyr briefly.`);
    note("Zephyr.md", "file-title", "", FILLER);
    expect(await top("zephyr")).toEqual(["file-title", "body"]);
  });

  it("a heading inside a fenced code block is not a heading", async () => {
    note("fenced.md", "fenced", "", `${FILLER}\n\n\`\`\`md\n## Zephyr\n\`\`\``);
    note("heading.md", "heading", "", `## Zephyr\n\n${FILLER}`);
    expect(await top("zephyr")).toEqual(["heading", "fenced"]);
  });

  it("fts_weights tunes a column: with aliases weighted 0, an alias match no longer wins", async () => {
    cfg.ftsWeights = { ...cfg.ftsWeights, aliases: 0 };
    note("body.md", "body", "", `${FILLER} We discussed zephyr briefly.`);
    note("alias.md", "alias", "aliases: [Zephyr]\n", FILLER);
    expect((await top("zephyr"))[0]).toBe("body");
  });
});

describe("wikilinks end to end (#36)", () => {
  it("links written in notes show up as related in both directions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "qkb-links-"));
    try {
      const cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
      cfg.vaultPath = join(tmp, "vault");
      mkdirSync(join(cfg.vaultPath, "Projects"), { recursive: true });
      cfg.dbPath = join(tmp, "qkb.db");
      cfg.embeddingProvider = "fake";
      cfg.embeddingDim = 8;
      writeFileSync(
        join(cfg.vaultPath, "Hub.md"),
        "---\nid: hub\n---\n\nSee [[Projects/Plan#Q3|the plan]].\n",
      );
      writeFileSync(
        join(cfg.vaultPath, "Projects", "Plan.md"),
        "---\nid: plan\n---\n\nThe plan.\n",
      );
      const conn = connect(cfg.dbPath, cfg.embeddingDim);
      await ingestVault(conn, cfg);
      const { getDocument } = await import("../src/search/retrieval.js");
      expect(getDocument(conn, "hub").related.map((r) => [r.document_id, r.relation])).toEqual([
        ["plan", "links_to"],
      ]);
      expect(getDocument(conn, "plan").related.map((r) => [r.document_id, r.relation])).toEqual([
        ["hub", "linked_from"],
      ]);
      conn.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sibling fields end to end", () => {
  let tmp: string;
  let cfgPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-sib-"));
    mkdirSync(join(tmp, "vault"));
    cfgPath = join(tmp, "config.toml");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function load(fieldsToml: string): Config {
    writeFileSync(
      cfgPath,
      `[vault]\npath = "${join(tmp, "vault")}"\n[database]\npath = "${join(tmp, "qkb.db")}"\n` +
        `[embedding]\nprovider = "fake"\ndimension = 8\n[frontmatter.fields]\n${fieldsToml}`,
    );
    return loadConfig(cfgPath, {});
  }

  function note(id: string, frontmatter: string, body = "Meeting notes."): void {
    writeFileSync(join(tmp, "vault", `${id}.md`), `---\nid: ${id}\n${frontmatter}---\n\n${body}\n`);
  }

  it("parses the table form and rejects unknown keys", () => {
    const cfg = load(
      'source = { description = "Where a clip came from", siblings = true }\nproject = "Project"\n',
    );
    expect(cfg.fields).toEqual({ source: "Where a clip came from", project: "Project" });
    expect(cfg.siblingFields).toEqual(["source"]);
    expect(() => load("source = { sibling = true }\n")).toThrow(/unknown key "sibling"/);
    expect(() => load('source = { siblings = "yes" }\n')).toThrow(/true or false/);
  });

  it("notes sharing a sibling value are related, and the value ranks above an ordinary field", async () => {
    const cfg = load(
      'author = { description = "Who wrote it", siblings = true }\nproject = "Project"\n',
    );
    note("by-alice", "author: Alice Smith\n");
    note("also-alice", "author: [Alice Smith, Bob Jones]\n");
    note("project-alice", "project: Alice Smith\n");
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg);
    const hits = await executeSearch(conn, cfg, null, "alice", new Filters(), null, "bm25");
    // Same value, same length: the sibling field (weight 3) outranks the
    // ordinary field (weight 2).
    const order = hits.map((h) => h.document_id);
    expect(order.indexOf("by-alice")).toBeLessThan(order.indexOf("project-alice"));
    const byAlice = hits.find((h) => h.document_id === "by-alice");
    expect(byAlice?.related.map((r) => [r.document_id, r.relation, r.field])).toEqual([
      ["also-alice", "sibling", "author"],
    ]);
    conn.close();
  });
});
