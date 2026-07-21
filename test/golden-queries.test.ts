import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GOLDEN_QUERIES_PATH,
  formatReport,
  parseGoldenQueries,
  runGoldenQueries,
  scorePassed,
} from "../scripts/golden-queries.js";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/scripts/golden_queries.py's behavior: same YAML schema
// (`legacy/python/scripts/golden_queries.example.yaml`), same scoring
// definition (expect_title_contains as a case-insensitive substring of one
// of the hybrid top-3 titles), same >=80% pass threshold. Exercised here
// against synthetic fixtures with FakeProvider — the real vault run is
// Task 18's manual acceptance step, never committed to this repo.

const DIM = 8;

function makeNote(overrides: Partial<ParsedNote> = {}): ParsedNote {
  const base: ParsedNote = {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d401",
    type: "note",
    title: "Traefik Cert Renewal",
    context: "homelab-traefik",
    source: null,
    effectiveDate: "2026-03-15",
    createdAt: "2026-03-15T10:00:00-06:00",
    tags: ["networking", "ssl"],
    extraMetadata: { status: "resolved" },
    body: "# Traefik\n\nRenewing certificates requires restarting the proxy container.",
    filePath: "02-Areas/Homelab/Traefik Cert Renewal.md",
  };
  return { ...base, ...overrides };
}

async function ingestOne(
  conn: Database.Database,
  provider: FakeProvider,
  note: ParsedNote,
): Promise<void> {
  const chunks = chunkText(note.body);
  const embeddings = await provider.embed(chunks.map((c) => c.text));
  new Storage(conn).upsert(note, contentHash(note.body), chunks, embeddings);
}

describe("parseGoldenQueries", () => {
  it("parses the documented schema (query, expect_title_contains, optional context)", () => {
    const yamlText = `
queries:
  - query: "how did I fix the reverse proxy certificate renewal"
    expect_title_contains: "Traefik"
  - query: "what did we decide at the project kickoff"
    expect_title_contains: "Kickoff"
    context: "acme-corp-pm-role"
`;
    expect(parseGoldenQueries(yamlText)).toEqual([
      {
        query: "how did I fix the reverse proxy certificate renewal",
        expect_title_contains: "Traefik",
      },
      {
        query: "what did we decide at the project kickoff",
        expect_title_contains: "Kickoff",
        context: "acme-corp-pm-role",
      },
    ]);
  });

  it("returns an empty list when `queries` is absent", () => {
    expect(parseGoldenQueries("")).toEqual([]);
  });

  it("throws when `queries` is not a list", () => {
    expect(() => parseGoldenQueries("queries: not-a-list")).toThrow(/must be a list/);
  });

  it("throws when an entry is missing a required field", () => {
    const yamlText = `
queries:
  - query: "missing expect_title_contains"
`;
    expect(() => parseGoldenQueries(yamlText)).toThrow(/missing required/);
  });
});

describe("runGoldenQueries / scorePassed / formatReport", () => {
  let conn: Database.Database;
  let provider: FakeProvider;
  let cfg: Config;

  beforeEach(async () => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.embeddingDim = DIM; // match the in-memory chunks_vec table's dimension

    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "f47ac10b-58cc-4372-a567-0e02b2c3d401",
        title: "Traefik Cert Renewal",
        context: "homelab-traefik",
        body: "Renewing certificates requires restarting the proxy container.",
        filePath: "02-Areas/Homelab/Traefik Cert Renewal.md",
      }),
    );
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "f47ac10b-58cc-4372-a567-0e02b2c3d402",
        title: "Project Kickoff Notes",
        context: "acme-corp-pm-role",
        body: "We decided to ship the MVP by end of quarter.",
        filePath: "02-Areas/Work/Kickoff Notes.md",
      }),
    );
  });

  afterEach(() => {
    conn.close();
  });

  it("scores a hit when the expected title appears in the hybrid top-3", async () => {
    const queries = [{ query: "traefik certificate renewal", expect_title_contains: "Traefik" }];
    const outcomes = await runGoldenQueries(conn, cfg, provider, queries);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.titles).toContain("Traefik Cert Renewal");
  });

  it("applies the optional context filter", async () => {
    const queries = [
      {
        query: "project kickoff decisions",
        expect_title_contains: "Kickoff",
        context: "acme-corp-pm-role",
      },
    ];
    const outcomes = await runGoldenQueries(conn, cfg, provider, queries);
    expect(outcomes[0]?.ok).toBe(true);
  });

  it("scores a miss when no top-3 title contains the expected substring", async () => {
    const queries = [
      { query: "traefik certificate renewal", expect_title_contains: "Nonexistent Doc Title" },
    ];
    const outcomes = await runGoldenQueries(conn, cfg, provider, queries);
    expect(outcomes[0]?.ok).toBe(false);
  });

  it("scorePassed requires >=80% and at least one query", () => {
    expect(scorePassed([])).toBe(false);
    expect(
      scorePassed([
        { query: "a", ok: true, titles: [] },
        { query: "b", ok: true, titles: [] },
        { query: "c", ok: true, titles: [] },
        { query: "d", ok: true, titles: [] },
        { query: "e", ok: false, titles: [] },
      ]),
    ).toBe(true); // 4/5 = 80%
    expect(
      scorePassed([
        { query: "a", ok: true, titles: [] },
        { query: "b", ok: false, titles: [] },
        { query: "c", ok: false, titles: [] },
        { query: "d", ok: false, titles: [] },
        { query: "e", ok: false, titles: [] },
      ]),
    ).toBe(false); // 1/5 = 20%
  });

  it("formatReport renders PASS/FAIL lines and the N/total summary", () => {
    const report = formatReport([
      { query: "hit query", ok: true, titles: ["Traefik Cert Renewal"] },
      { query: "miss query", ok: false, titles: [null] },
    ]);
    expect(report).toContain('PASS  "hit query" -> ["Traefik Cert Renewal"]');
    expect(report).toContain('FAIL  "miss query" -> [null]');
    expect(report).toContain("1/2 in top 3 (target: >=80%)");
  });

  it("end-to-end: >=80% synthetic hit rate mirrors the PRD target", async () => {
    const queries = [
      { query: "traefik certificate renewal", expect_title_contains: "Traefik" },
      {
        query: "project kickoff decisions",
        expect_title_contains: "Kickoff",
        context: "acme-corp-pm-role",
      },
    ];
    const outcomes = await runGoldenQueries(conn, cfg, provider, queries);
    expect(scorePassed(outcomes)).toBe(true);
  });
});

describe("DEFAULT_GOLDEN_QUERIES_PATH", () => {
  it("points at the owner's private per-user config dir, never a repo path", () => {
    expect(DEFAULT_GOLDEN_QUERIES_PATH).toMatch(/\.config[\\/]qkb[\\/]golden_queries\.yaml$/);
  });
});
