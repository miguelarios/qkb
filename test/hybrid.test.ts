import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { Filters } from "../src/search/filters.js";
import { rrfMerge, search } from "../src/search/hybrid.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_hybrid.py — RRF fusion (rrf_k=60), the score
// formula, iteration/tie-break order over both result lists, and tier
// orchestration (bm25 | vector | hybrid). THIS IS THE GOLDEN-QUERY BAR: fusion
// ordering parity with Python is the whole point, so this is a port, not a
// reinterpretation.

const DIM = 8;

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

/** Chunk + embed + upsert a note — ports conftest.py's `ingest_one`. */
async function ingestOne(
  conn: Database.Database,
  provider: FakeProvider,
  note: ParsedNote,
): Promise<void> {
  const chunks = chunkText(note.body);
  const embeddings = await provider.embed(chunks.map((c) => c.text));
  new Storage(conn).upsert(note, contentHash(note.body), chunks, embeddings);
}

/** deterministic defaults (never read the machine's real config.toml). Mirrors
 * test_hybrid.py's `make_cfg` (fake provider, 8-d). */
function makeCfg() {
  const c = loadConfig("/nonexistent/qkb-test-config.toml", {});
  c.embeddingProvider = "fake";
  c.embeddingDim = DIM;
  return c;
}

/** Ports test_hybrid.py's `seed`. */
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
      title: "Bread Recipe",
      context: "cooking",
      filePath: "03-Resources/Bread.md",
      body: "Knead the dough and let it rise near the warm proxy of the oven.",
    }),
  );
}

describe("search/hybrid", () => {
  describe("rrfMerge", () => {
    it("computes RRF scores and weights (ports test_rrf_merge_scores)", () => {
      const l1: Array<[string, number]> = [
        ["a", 9.0],
        ["b", 5.0],
      ];
      const l2: Array<[string, number]> = [
        ["b", 0.9],
        ["a", 0.5],
      ];
      const merged = rrfMerge([l1, l2], 60);
      const scores = new Map(merged);
      expect(scores.get("a")).toBe(1 / 61 + 1 / 62);
      expect(scores.get("b")).toBe(1 / 62 + 1 / 61);

      const weighted = rrfMerge([l1, l2], 60, [2.0, 1.0]);
      expect(new Map(weighted).get("a")).toBe(2 * (1 / 61) + 1 / 62);
    });

    it("preserves first-appearance insertion order for tied scores", () => {
      // a and b end with identical scores; a first appears in l1 (rank 0), b
      // second — Python's dict is insertion-ordered and `sorted(..., reverse=True)`
      // is stable, so ties keep first-appearance order [a, b]. JS Map + stable
      // Array.sort must match.
      const l1: Array<[string, number]> = [
        ["a", 9.0],
        ["b", 5.0],
      ];
      const l2: Array<[string, number]> = [
        ["b", 0.9],
        ["a", 0.5],
      ];
      const merged = rrfMerge([l1, l2], 60);
      expect(merged.map((r) => r[0])).toEqual(["a", "b"]);
    });
  });

  describe("search (tiers)", () => {
    let conn: Database.Database;
    let provider: FakeProvider;

    beforeEach(() => {
      conn = connect(":memory:", DIM);
      provider = new FakeProvider(DIM);
    });

    afterEach(() => {
      conn.close();
    });

    it("all three tiers return results with ID_A first (ports test_all_three_tiers_return_results)", async () => {
      await seed(conn, provider);
      const cfg = makeCfg();
      // Exact body text of ID_A: FakeProvider embeds identical text to distance
      // 0, so the vector tier is deterministic; bm25/hybrid also rank ID_A.
      const query = "Renewing certificates requires restarting the proxy.";
      for (const tier of ["bm25", "vector", "hybrid"]) {
        const results = await search(conn, cfg, provider, query, new Filters(), 5, tier);
        expect(results.length, tier).toBeGreaterThan(0);
        expect(results[0]?.[0], tier).toBe(ID_A);
      }
    });

    it("hybrid attaches matched text (ports test_hybrid_attaches_matched_text)", async () => {
      await seed(conn, provider);
      const results = await search(
        conn,
        makeCfg(),
        provider,
        "certificates proxy",
        new Filters(),
        5,
        "hybrid",
      );
      const docIds = results.map((r) => r[0]);
      expect(docIds).toContain(ID_A);
      expect(results.every((r) => typeof r[2] === "string" && r[2])).toBe(true);
    });

    it("hybrid limit above candidate pool is not truncated (ports test_hybrid_limit_above_candidate_pool_not_truncated)", async () => {
      const cfg = makeCfg();
      cfg.ftsCandidates = 3;
      cfg.vecCandidates = 3;
      const nDocs = 8;
      for (let i = 0; i < nDocs; i++) {
        await ingestOne(
          conn,
          provider,
          makeNote({
            id: `hydoc-${String(i).padStart(4, "0")}`,
            title: `Hybrid Doc ${i}`,
            context: "homelab-traefik",
            filePath: `02-Areas/Homelab/HyDoc${i}.md`,
            body: `proxy configuration notes number ${i} for the certificate renewal task`,
          }),
        );
      }
      const results = await search(
        conn,
        cfg,
        provider,
        "proxy certificate",
        new Filters(),
        15,
        "hybrid",
      );
      expect(results.length).toBeGreaterThan(cfg.vecCandidates);
      expect(results.length).toBe(nDocs);
    });

    it("vector/hybrid without a provider raise (parity with hybrid.py None check)", async () => {
      await seed(conn, provider);
      const cfg = makeCfg();
      for (const tier of ["vector", "hybrid"]) {
        await expect(
          search(conn, cfg, null, "certificates", new Filters(), 5, tier),
        ).rejects.toThrow(/requires an embedding provider/);
      }
    });

    it("unknown tier raises", async () => {
      await seed(conn, provider);
      await expect(
        search(conn, makeCfg(), provider, "certificates", new Filters(), 5, "nope"),
      ).rejects.toThrow(/unknown tier/);
    });
  });
});
