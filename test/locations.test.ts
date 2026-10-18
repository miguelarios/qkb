import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { parseNote } from "../src/ingest/parser.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";

// #15: results point at the line of the source file where the match is, so
// `note.md:42` can be opened straight from an editor or agent.

const DIM = 8;
const ID = "f47ac10b-58cc-4372-a567-0e02b2c3d401";

function paragraphs(n: number, word: string): string {
  return Array.from({ length: n }, (_, i) => `${word} paragraph ${i} ${"lorem ipsum ".repeat(12)}`)
    .join("\n\n")
    .trim();
}

describe("chunk line spans", () => {
  it.each([
    ["short", "Just one line."],
    ["leading blank lines", "\n\n\nStarts late.\nSecond line.\n\n"],
    ["headings", "# One\n\ntext a\n\n# Two\n\ntext b\n"],
    ["long, with overlap", paragraphs(40, "alpha")],
    ["fenced code", `intro\n\n\`\`\`\n${"code line\n".repeat(300)}\`\`\`\n\noutro`],
  ])("each chunk's span is exactly its text (%s)", (_name, text) => {
    const lines = text.split("\n");
    const chunks = chunkText(text, 100, 15);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine as number);
      expect(lines.slice((c.startLine as number) - 1, c.endLine).join("\n")).toBe(c.text);
    }
  });
});

describe("result locations", () => {
  let vault: string;
  let conn: Database.Database;
  let cfg: Config;
  let provider: FakeProvider;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "qkb-loc-"));
    conn = connect(":memory:", DIM);
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = vault;
    cfg.chunkTargetTokens = 100;
    cfg.embeddingDim = DIM;
    provider = new FakeProvider(DIM);
  });
  afterEach(() => {
    conn.close();
    rmSync(vault, { recursive: true, force: true });
  });

  const body = `${paragraphs(12, "alpha")}\n\n## Renewal\n\nThe zebracorn certificate renews nightly.\n\n${paragraphs(12, "omega")}`;

  function write(frontmatterExtra = ""): string {
    const p = join(vault, "Note.md");
    writeFileSync(p, `---\nid: ${ID}\ncreated: 2026-01-01\n${frontmatterExtra}---\n\n${body}\n`);
    return p;
  }

  function lineOf(path: string, needle: string): number {
    return (
      readFileSync(path, "utf-8")
        .split("\n")
        .findIndex((l) => l.includes(needle)) + 1
    );
  }

  async function search(tier: "search" | "vsearch", q: string) {
    return executeSearch(
      conn,
      cfg,
      provider,
      q,
      new Filters({}),
      5,
      tier === "vsearch" ? "vector" : "bm25",
    );
  }

  it("the parser reports the file line the body starts on", () => {
    const p = write("tags: [a, b]\n");
    // ---, id, created, tags, --- → the body starts on line 6 (a blank line).
    expect(parseNote(p, vault, cfg.frontmatter)?.bodyLine).toBe(6);
  });

  it("a keyword match points at the line holding the matched text", async () => {
    const p = write();
    await ingestVault(conn, cfg, { provider });
    const [r] = await search("search", "zebracorn");
    expect(r?.line).toBe(lineOf(p, "zebracorn"));
  });

  it("a vector match points at the first line of the matched chunk", async () => {
    const p = write();
    await ingestVault(conn, cfg, { provider });
    const [r] = await search("vsearch", "anything");
    expect(r?.matched_text).toBeTruthy();
    const firstLine = String(r?.matched_text).split("\n")[0] as string;
    expect(r?.line).toBe(lineOf(p, firstLine));
  });

  it("stays right when only the frontmatter grows (body unchanged)", async () => {
    write();
    await ingestVault(conn, cfg, { provider });
    const p = write("aliases:\n  - One\n  - Two\n  - Three\n");
    await ingestVault(conn, cfg, { provider });
    const [r] = await search("search", "zebracorn");
    expect(r?.line).toBe(lineOf(p, "zebracorn"));
  });

  it("backfills an index built before line numbers were stored", async () => {
    const p = write();
    await ingestVault(conn, cfg, { provider });
    conn.exec("UPDATE chunks SET start_line = NULL, end_line = NULL");
    conn.exec("UPDATE documents SET body_line = NULL");
    expect((await search("search", "zebracorn"))[0]?.line).toBeNull();

    const vectorsBefore = (conn.prepare("SELECT COUNT(*) c FROM chunks_vec").get() as { c: number })
      .c;
    await ingestVault(conn, cfg, { provider });
    expect((await search("search", "zebracorn"))[0]?.line).toBe(lineOf(p, "zebracorn"));
    // Backfilling must not re-chunk, so no vector is dropped or re-embedded.
    expect((conn.prepare("SELECT COUNT(*) c FROM chunks_vec").get() as { c: number }).c).toBe(
      vectorsBefore,
    );
  });

  it("adds the columns to an index created before them", () => {
    const dir = mkdtempSync(join(tmpdir(), "qkb-mig-"));
    try {
      const dbPath = join(dir, "old.db");
      const old = connect(dbPath, DIM);
      old.exec("ALTER TABLE chunks DROP COLUMN start_line");
      old.exec("ALTER TABLE chunks DROP COLUMN end_line");
      old.exec("ALTER TABLE documents DROP COLUMN body_line");
      old.close();
      const reopened = connect(dbPath, DIM);
      const cols = (t: string) =>
        (reopened.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      expect(cols("chunks")).toEqual(expect.arrayContaining(["start_line", "end_line"]));
      expect(cols("documents")).toContain("body_line");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
