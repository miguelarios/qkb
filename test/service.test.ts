import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_service.py — the shared "resolve limit ->
// validate -> guard (ingest-in-progress / dimension mismatch) -> run tiered
// search -> hydrate" pipeline that both the CLI and MCP call. Every ported
// case asserts result COUNT or a raised error, exactly as Python does —
// hydrated-shape assertions live in test/hydrate.test.ts.

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

describe("search/service executeSearch", () => {
  let conn: Database.Database;
  let provider: FakeProvider;
  let cfg: Config;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
    // deterministic defaults; mirror the `cfg` fixture (default_limit = 2).
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.defaultLimit = 2;
  });

  afterEach(() => {
    conn.close();
  });

  it("limit=null falls back to cfg.defaultLimit (ports test_limit_none_falls_back_to_cfg_default)", async () => {
    for (let i = 0; i < 3; i++) {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `f47ac10b-58cc-4372-a567-0e02b2c3d4${String(i).padStart(2, "0")}`,
          title: `Traefik note ${i}`,
          filePath: `02-Areas/Homelab/Traefik${i}.md`,
          body: "Renewing traefik certificates.",
        }),
      );
    }
    const results = await executeSearch(
      conn,
      cfg,
      provider,
      "traefik",
      new Filters(),
      null,
      "bm25",
    );
    expect(results.length).toBe(cfg.defaultLimit);
    expect(cfg.defaultLimit).toBe(2);
  });

  it.each([0, -1, -10])(
    "limit below one is rejected (%i) (ports test_limit_below_one_rejected)",
    async (badLimit) => {
      await expect(
        executeSearch(conn, cfg, provider, "traefik", new Filters(), badLimit, "bm25"),
      ).rejects.toThrow(/limit must be >= 1/);
    },
  );

  it("explicit limit overrides default (ports test_explicit_limit_overrides_default)", async () => {
    for (let i = 0; i < 3; i++) {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `f47ac10b-58cc-4372-a567-0e02b2c3d4${String(i).padStart(2, "0")}`,
          title: `Traefik note ${i}`,
          filePath: `02-Areas/Homelab/Traefik${i}.md`,
          body: "Renewing traefik certificates.",
        }),
      );
    }
    const results = await executeSearch(conn, cfg, provider, "traefik", new Filters(), 3, "bm25");
    expect(results.length).toBe(3);
  });

  it("dimension mismatch raises for vector and hybrid (ports test_dimension_mismatch_raises_value_error_for_vector_and_hybrid)", async () => {
    // After embedding_dim changes without a re-ingest, chunks_vec is still at
    // the old dimension. Vector/hybrid must raise a friendly error, not let
    // sqlite-vec's raw dimension error through.
    await ingestOne(conn, provider, makeNote());
    cfg.embeddingDim = DIM + 1; // conn's chunks_vec was created at DIM
    const queryProvider = new FakeProvider(DIM + 1);

    for (const tier of ["vector", "hybrid"]) {
      await expect(
        executeSearch(conn, cfg, queryProvider, "traefik", new Filters(), null, tier),
      ).rejects.toThrow(/dimension/);
      await expect(
        executeSearch(conn, cfg, queryProvider, "traefik", new Filters(), null, tier),
      ).rejects.toThrow(/--full/);
    }
  });

  it("dimension mismatch does not block bm25 (ports test_dimension_mismatch_does_not_block_bm25)", async () => {
    await ingestOne(conn, provider, makeNote());
    cfg.embeddingDim = DIM + 1;
    const queryProvider = new FakeProvider(DIM + 1);

    const results = await executeSearch(
      conn,
      cfg,
      queryProvider,
      "traefik",
      new Filters(),
      null,
      "bm25",
    );
    expect(results.length).toBe(1);
  });

  it("ingest-in-progress blocks every tier until cleared (ports test_ingest_in_progress_blocks_every_tier)", async () => {
    cfg.embeddingDim = DIM; // keep the dimension guard out of this test's way
    await ingestOne(conn, provider, makeNote());
    new Storage(conn).markIngestInProgress();

    for (const tier of ["bm25", "vector", "hybrid"]) {
      await expect(
        executeSearch(conn, cfg, provider, "traefik", new Filters(), null, tier),
      ).rejects.toThrow(/rebuild/);
      await expect(
        executeSearch(conn, cfg, provider, "traefik", new Filters(), null, tier),
      ).rejects.toThrow(/--full/);
    }

    new Storage(conn).clearIngestInProgress();
    for (const tier of ["bm25", "vector", "hybrid"]) {
      const results = await executeSearch(
        conn,
        cfg,
        provider,
        "traefik",
        new Filters(),
        null,
        tier,
      );
      expect(results.length).toBe(1);
    }
  });
});
