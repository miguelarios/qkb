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

    // Fix round 1 (reviewer flag): verify tokenization is byte-identical to
    // CPython's `re.findall(r"\w+", query, flags=re.UNICODE)` for exactly the
    // character classes the reviewer named — combining marks (Mn/Mc) and
    // connector punctuation (Pc) — plus NFD-normalized text. Expected values
    // below are the literal output of `python3 -c "import re; ..."` probes
    // against CPython 3.14 (see ts-task-11-report.md "Fix round 1" for the
    // full probe transcript), not hand-derived — CPython's `\w` does NOT
    // extend to Mn/Mc or to Pc characters other than ASCII `_`, so it
    // excludes combining marks and connector punctuation exactly as
    // `[\p{L}\p{N}_]+` does.
    it("NFD-decomposed accents: combining mark (Mn) breaks the run, is dropped", () => {
      // "café" as NFD: c,a,f,e + COMBINING ACUTE ACCENT (U+0301, category Mn).
      // Python: re.findall(r"\w+", "café") == ["cafe"] (accent dropped,
      // "cafe" NOT split at the combining mark's position since it simply
      // isn't part of any run).
      const nfdCafe = "café".normalize("NFD");
      expect(sanitizeQuery(nfdCafe)).toBe('"cafe"');
    });

    it("Devanagari word: Mc/Mn matras and virama break the run into single-letter tokens", () => {
      // "हिन्दी" (Devanagari "Hindi"): Lo,Mc,Lo,Mn,Lo,Mc. Python:
      // re.findall(r"\w+", "हिन्दी") == ["ह", "न", "द"] — the three Lo
      // (letter) codepoints each isolated by a following Mc/Mn character.
      expect(sanitizeQuery("हिन्दी")).toBe('"ह" "न" "द"');
    });

    it("connector punctuation other than ASCII underscore (Pc, U+203F) splits the run", () => {
      // U+203F UNDERTIE is category Pc but is NOT \w in CPython. Python:
      // re.findall(r"\w+", "a‿b") == ["a", "b"].
      expect(sanitizeQuery("a‿b")).toBe('"a" "b"');
    });

    it("ASCII underscore (also Pc) does NOT split the run", () => {
      // Python: re.findall(r"\w+", "a_b") == ["a_b"] — underscore is \w by
      // the explicit `|| ch == '_'` in CPython's word-char test, not because
      // it's Pc (other Pc chars, per the case above, are excluded).
      expect(sanitizeQuery("a_b")).toBe('"a_b"');
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
