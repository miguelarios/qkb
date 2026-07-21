import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { sanitizeQuery, searchBm25 } from "../src/search/bm25.js";
import { Filters } from "../src/search/filters.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_bm25.py — weighted bm25(documents_fts,
// 5,3,2,1,0.5), FTS5 MATCH query escaping, filter application, candidate
// cap. Ranking parity here feeds directly into Task 13's RRF fusion, so the
// SQL and weights must be identical to bm25.py, not just "close enough".

const DIM = 8;
const W = [5.0, 3.0, 2.0, 1.0, 0.5];

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

/** Chunk + embed + upsert a note (test helper mirroring the pipeline) —
 * ports conftest.py's `ingest_one`. */
async function ingestOne(
  conn: Database.Database,
  provider: FakeProvider,
  note: ParsedNote,
): Promise<void> {
  const chunks = chunkText(note.body);
  const embeddings = await provider.embed(chunks.map((c) => c.text));
  new Storage(conn).upsert(note, contentHash(note.body), chunks, embeddings);
}

/** Ports test_bm25.py's `seed` helper. */
async function seed(conn: Database.Database, provider: FakeProvider): Promise<void> {
  await ingestOne(
    conn,
    provider,
    makeNote({
      id: ID_A,
      title: "Traefik Cert Renewal",
      context: "homelab-traefik",
      body: "Renewing certificates requires restarting the proxy.",
    }),
  );
  await ingestOne(
    conn,
    provider,
    makeNote({
      id: ID_B,
      title: "Grocery List",
      context: "personal",
      tags: ["errands"],
      filePath: "00-Inbox/Grocery List.md",
      body: "Milk, eggs, bread. Also look at traefik dashboard sometime.",
    }),
  );
}

describe("search/bm25", () => {
  describe("sanitizeQuery", () => {
    it("wraps each word token in double quotes, dropping punctuation/operators", () => {
      expect(sanitizeQuery('traefik AND "cert')).toBe('"traefik" "AND" "cert"');
    });

    it("returns empty string when no word tokens are present", () => {
      expect(sanitizeQuery("!!!")).toBe("");
    });
  });

  describe("searchBm25", () => {
    let conn: Database.Database;
    let provider: FakeProvider;

    beforeEach(() => {
      conn = connect(":memory:", DIM);
      provider = new FakeProvider(DIM);
    });

    afterEach(() => {
      conn.close();
    });

    it("title match outranks body mention", async () => {
      await seed(conn, provider);
      const results = searchBm25(conn, "traefik", new Filters(), 10, W);
      expect(results.map((r) => r[0])[0]).toBe(ID_A); // title hit ranks first
      expect(results).toHaveLength(2); // body mention still found
      expect(results[0]?.[1]).toBeGreaterThan(results[1]?.[1] as number); // higher score = better
    });

    it("filters restrict results", async () => {
      await seed(conn, provider);
      const results = searchBm25(conn, "traefik", new Filters({ context: "personal" }), 10, W);
      expect(results.map((r) => r[0])).toEqual([ID_B]);
    });

    it("empty query returns nothing", async () => {
      await seed(conn, provider);
      expect(searchBm25(conn, "???", new Filters(), 10, W)).toEqual([]);
    });

    it("partial date_from filter restricts real search results (deferred from Task 10)", async () => {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          title: "Old Traefik Note",
          context: "homelab-traefik",
          effectiveDate: "2025-06-01",
          filePath: "02-Areas/Homelab/Old Traefik Note.md",
          body: "Renewing certificates requires restarting the proxy.",
        }),
      );
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          title: "New Traefik Note",
          context: "homelab-traefik",
          effectiveDate: "2026-03-15",
          filePath: "02-Areas/Homelab/New Traefik Note.md",
          body: "Renewing certificates requires restarting the proxy.",
        }),
      );
      const results = searchBm25(conn, "traefik", new Filters({ dateFrom: "2026" }), 10, W);
      expect(results.map((r) => r[0])).toEqual(["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    });

    it("respects the candidate/limit cap", async () => {
      for (let i = 0; i < 5; i++) {
        const id = `11111111-1111-4111-8111-11111111111${i}`;
        await ingestOne(
          conn,
          provider,
          makeNote({
            id,
            title: `Traefik Note ${i}`,
            filePath: `02-Areas/Homelab/Traefik Note ${i}.md`,
            body: "Renewing certificates requires restarting the proxy.",
          }),
        );
      }
      const results = searchBm25(conn, "traefik", new Filters(), 3, W);
      expect(results).toHaveLength(3);
    });
  });
});
