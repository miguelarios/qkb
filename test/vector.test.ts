import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { Filters } from "../src/search/filters.js";
import { searchVector } from "../src/search/vector.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_vector.py — chunk-level KNN via chunks_vec
// MATCH, filter pre-restriction of the candidate chunk set, chunk->document
// dedup keeping the best (smallest) distance, and iterative pool growth so a
// small `candidates` doesn't silently starve the document-level result set.
// Ranking/dedup semantics here feed directly into Task 13's RRF fusion, so
// this must be a port, not a reinterpretation.

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

/** Ports test_vector.py's `seed` helper. */
async function seed(conn: Database.Database, provider: FakeProvider): Promise<void> {
  await ingestOne(
    conn,
    provider,
    makeNote({
      id: ID_A,
      title: "Certificates",
      context: "homelab-traefik",
      body: "Renewing TLS certificates for the reverse proxy.",
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
      body: "Knead the dough and let it rise for two hours.",
    }),
  );
}

describe("search/vector", () => {
  let conn: Database.Database;
  let provider: FakeProvider;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
  });

  afterEach(() => {
    conn.close();
  });

  it("exact text ranks first", async () => {
    // FakeProvider gives identical vectors for identical text -> distance 0
    await seed(conn, provider);
    const results = await searchVector(
      conn,
      "Renewing TLS certificates for the reverse proxy.",
      new Filters(),
      5,
      10,
      provider,
    );
    expect(results[0]?.[0]).toBe(ID_A);
    expect(results[0]?.[1]).toBeGreaterThan(results[results.length - 1]?.[1] as number);
  });

  it("dedups to documents", async () => {
    await seed(conn, provider);
    const longBody = Array.from(
      { length: 5 },
      () => `Section about sourdough starter. ${"filler ".repeat(80)}`,
    ).join("\n\n");
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        title: "Long Doc",
        context: "cooking",
        filePath: "03-Resources/Long.md",
        body: longBody,
      }),
    );
    const results = await searchVector(conn, "sourdough starter", new Filters(), 10, 20, provider);
    const ids = results.map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length); // one entry per document
  });

  it("applies filters", async () => {
    await seed(conn, provider);
    const results = await searchVector(
      conn,
      "certificates",
      new Filters({ context: "cooking" }),
      5,
      10,
      provider,
    );
    expect(results.every((r) => r[0] === ID_B)).toBe(true);
  });

  it("filter restricts candidates before KNN runs (finding 5)", async () => {
    // A filtered vector search must not run KNN globally first and filter
    // afterward, or a filter-passing match outside the global top-k is
    // silently dropped (DESIGN.md §8.5 promises pre-restriction). FakeProvider
    // gives identical text identical vectors -> distance 0. Seed many
    // out-of-context decoy docs whose body is the exact query text (so they
    // dominate the global top-k), plus one in-context target doc with
    // unrelated text (nonzero distance, ranked far outside the global
    // top-k). `candidates` is small enough that the old `k = candidates * 4`
    // global search never reaches the target doc.
    const query = "certificate renewal steps for the reverse proxy";
    const candidates = 3; // old code: k = candidates * 4 = 12
    const nDecoys = 20; // >> 12, so the target is pushed well outside the old global top-k
    for (let i = 0; i < nDecoys; i++) {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `decoy-${String(i).padStart(4, "0")}`,
          title: `Decoy ${i}`,
          context: "cooking",
          filePath: `03-Resources/Decoy${i}.md`,
          body: query, // identical text -> distance 0, globally nearest
        }),
      );
    }
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "target-0001",
        title: "Traefik Renewal Target",
        context: "homelab-traefik",
        filePath: "02-Areas/Homelab/Target.md",
        body: "Unrelated maintenance notes about disk usage on the NAS.",
      }),
    );

    const unfiltered = await searchVector(conn, query, new Filters(), 5, candidates, provider);
    expect(unfiltered.length).toBeGreaterThan(0); // sanity: unfiltered search should still find the global nearest decoys
    expect(unfiltered.every((r) => r[0].startsWith("decoy-"))).toBe(true);

    const filtered = await searchVector(
      conn,
      query,
      new Filters({ context: "homelab-traefik" }),
      5,
      candidates,
      provider,
    );
    expect(filtered.length).toBeGreaterThan(0); // filtered search must find the in-context doc even though it's outside the global top-k
    expect(filtered.every((r) => r[0] === "target-0001")).toBe(true);
  });

  it("a long document does not crowd out other documents (finding 3)", async () => {
    // `k` sizes the KNN pool in CHUNKS, but results dedup to DOCUMENTS. A
    // single many-chunk document whose chunks all rank nearest the query must
    // not crowd the whole chunk pool and starve every other filter-passing
    // document out of the document-level result set. One document is chunked
    // into 12 IDENTICAL sections (FakeProvider gives identical text identical
    // vectors -> distance 0 for all 12), so with the old fixed-size pool
    // (k = max(candidates, limit)) every slot in a small pool is consumed by
    // ties from this one document, and 15 other filter-passing single-chunk
    // documents never appear at all. The fix must grow the pool until `limit`
    // distinct documents are collected.
    const section = `## Section\n\nContent block about the reverse proxy certificate renewal. ${"filler word ".repeat(80)}`;
    const query = section;
    const longBody = Array(12).fill(section).join("\n\n");
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "long-0001",
        title: "Long Doc",
        context: "homelab-traefik",
        filePath: "02-Areas/Homelab/Long.md",
        body: longBody,
      }),
    );
    const nSingles = 15;
    for (let i = 0; i < nSingles; i++) {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `single-${String(i).padStart(4, "0")}`,
          title: `Single ${i}`,
          context: "homelab-traefik",
          filePath: `02-Areas/Homelab/Single${i}.md`,
          body: `Unrelated maintenance notes number ${i} about disk usage on the NAS.`,
        }),
      );
    }
    const limit = 10;
    const results = await searchVector(
      conn,
      query,
      new Filters({ context: "homelab-traefik" }),
      limit,
      5, // deliberately small: old k = max(5, 10) = 10 chunks,
      // all consumed by the 12 tied chunks of the single long document.
      provider,
    );
    const ids = results.map((r) => r[0]);
    // 16 filter-passing docs exist (1 long + 15 singles); limit=10 < 16, so
    // the fixed result set must be exactly `limit` DISTINCT documents.
    expect(new Set(ids).size).toBe(limit);
    expect(ids.length).toBe(limit);
  });

  it("returns every multi-chunk doc when limit equals doc count (finding 3)", async () => {
    // Several multi-chunk docs, `limit` == doc count, `candidates` smaller
    // than total chunk count -> every document must be returned, not just the
    // ones whose chunks happen to land in a too-small fixed pool.
    const query = "distinct content for the search index";
    const nDocs = 6;
    const chunksPerDoc = 6;
    // doc 0: every chunk identical to the query (distance 0 ties) so a
    // fixed-size small pool gets entirely consumed by this one document.
    const crowdingSection = `## Section\n\nContent block about the reverse proxy certificate renewal. ${"filler word ".repeat(80)}`;
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "multi-0000",
        title: "Multi Doc 0",
        context: "homelab-traefik",
        filePath: "02-Areas/Homelab/Multi0.md",
        body: Array(chunksPerDoc).fill(crowdingSection).join("\n\n"),
      }),
    );
    for (let d = 1; d < nDocs; d++) {
      const sections = Array.from(
        { length: chunksPerDoc },
        (_, s) =>
          `## Section ${d}-${s}\n\nDistinct filler content for doc ${d} section ${s}. ${"filler word ".repeat(80)}`,
      ).join("\n\n");
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `multi-${String(d).padStart(4, "0")}`,
          title: `Multi Doc ${d}`,
          context: "homelab-traefik",
          filePath: `02-Areas/Homelab/Multi${d}.md`,
          body: sections,
        }),
      );
    }
    const results = await searchVector(
      conn,
      query,
      new Filters(), // no filter leg of the pool-sizing fix
      nDocs,
      4, // smaller than total chunks (36) and smaller than n_docs
      provider,
    );
    const ids = results.map((r) => r[0]);
    expect(new Set(ids).size).toBe(nDocs);
    expect(ids.length).toBe(nDocs);
  });

  it("does not truncate when limit is above candidates (finding 6)", async () => {
    // Candidate k must scale with the requested limit, not just `candidates`
    // — otherwise a large limit is silently capped.
    const nDocs = 8;
    for (let i = 0; i < nDocs; i++) {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: `doc-${String(i).padStart(4, "0")}`,
          title: `Doc ${i}`,
          context: "homelab-traefik",
          filePath: `02-Areas/Homelab/Doc${i}.md`,
          body: `Distinct content about topic number ${i} for the search index.`,
        }),
      );
    }
    const candidates = 3; // deliberately smaller than both n_docs and limit
    const results = await searchVector(conn, "topic", new Filters(), 15, candidates, provider);
    expect(results.length).toBe(nDocs); // not capped at `candidates`
  });
});
