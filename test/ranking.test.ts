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
