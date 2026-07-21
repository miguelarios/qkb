import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { hydrate, obsidianUri } from "../src/search/hydrate.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_results.py — result-dict shape, sibling
// surfacing, context descriptions, and Obsidian URI construction. Key naming:
// hydrated result objects keep Python's snake_case dict keys verbatim
// (document_id, effective_date, context_description, obsidian_uri,
// matched_text) so JSON serialized by the CLI/MCP layers (Tasks 15/16) is
// byte-identical to Python's `json.dumps(results, indent=2)` output without a
// remapping step.

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

const ID_T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_N = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seedSiblings(conn: Database.Database, provider: FakeProvider): Promise<void> {
  await ingestOne(
    conn,
    provider,
    makeNote({
      id: ID_T,
      type: "transcript",
      title: "Kickoff Transcript",
      context: "acme-corp-pm-role",
      source: "2026-03-15-project-kickoff",
      filePath: "02-Areas/Work/Kickoff Transcript.md",
      body: "Alice Smith walked through the roadmap.",
    }),
  );
  await ingestOne(
    conn,
    provider,
    makeNote({
      id: ID_N,
      type: "ai-notes",
      title: "Kickoff Notes",
      context: "acme-corp-pm-role",
      source: "2026-03-15-project-kickoff",
      filePath: "02-Areas/Work/Kickoff Notes.md",
      body: "Decisions: roadmap approved.",
    }),
  );
}

describe("search/hydrate", () => {
  let conn: Database.Database;
  let provider: FakeProvider;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
  });

  afterEach(() => {
    conn.close();
  });

  it("obsidianUri percent-encodes vault + file, stripping .md (ports test_obsidian_uri)", () => {
    const uri = obsidianUri("Notes", "02-Areas/Work/2026-03-15 Kickoff.md");
    expect(uri).toBe("obsidian://open?vault=Notes&file=02-Areas%2FWork%2F2026-03-15%20Kickoff");
  });

  it("hydrates with siblings and context description (ports test_hydrate_with_siblings_and_description)", async () => {
    await seedSiblings(conn, provider);
    new Storage(conn).setContextDescription("acme-corp-pm-role", "PM work notes");
    const out = hydrate(conn, [[ID_T, 0.9, "roadmap chunk"]]);
    expect(out.length).toBe(1);
    const r = out[0];
    expect(r).toBeDefined();
    expect(r?.title).toBe("Kickoff Transcript");
    expect(r?.context_description).toBe("PM work notes");
    expect(r?.matched_text).toBe("roadmap chunk");
    expect(r?.obsidian_uri.startsWith("obsidian://open?vault=Notes&file=")).toBe(true);
    expect(r?.siblings.map((s) => s.document_id)).toEqual([ID_N]);
  });

  it("no source -> no siblings (ports test_hydrate_no_source_no_siblings)", async () => {
    await ingestOne(conn, provider, makeNote({ id: ID_T, source: null }));
    const out = hydrate(conn, [[ID_T, 0.5, null]]);
    expect(out[0]?.siblings).toEqual([]);
  });

  const ID_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const ID_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ID_C = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const ID_MISSING = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  it("multi-doc hydrate preserves order, skips missing ids, batches independently (ports test_hydrate_multi_doc_preserves_contract)", async () => {
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: ID_A,
        title: "Alpha Doc",
        context: "ctx-one",
        source: "shared-source",
        tags: ["zeta", "alpha"],
        filePath: "Alpha Doc.md",
      }),
    );
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: ID_B,
        title: "Beta Doc",
        context: "ctx-two",
        source: "shared-source",
        tags: [],
        filePath: "Beta Doc.md",
      }),
    );
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: ID_C,
        title: "Gamma Doc",
        context: null,
        source: null,
        tags: ["gamma"],
        filePath: "Gamma Doc.md",
      }),
    );
    new Storage(conn).setContextDescription("ctx-one", "First context");

    const ranked: Array<[string, number, string | null]> = [
      [ID_C, 0.123456789, "gamma match"],
      [ID_MISSING, 0.99, "should be skipped"],
      [ID_A, 0.987654321, "alpha match"],
      [ID_B, 0.5, null],
    ];
    const out = hydrate(conn, ranked);

    expect(out.map((r) => r.document_id)).toEqual([ID_C, ID_A, ID_B]);

    const byId = new Map(out.map((r) => [r.document_id, r]));

    const c = byId.get(ID_C);
    expect(c?.title).toBe("Gamma Doc");
    expect(c?.context).toBeNull();
    expect(c?.context_description).toBeNull();
    expect(c?.tags).toEqual(["gamma"]);
    expect(c?.siblings).toEqual([]);
    expect(c?.matched_text).toBe("gamma match");
    expect(c?.score).toBe(0.123457);

    const a = byId.get(ID_A);
    expect(a?.title).toBe("Alpha Doc");
    expect(a?.context).toBe("ctx-one");
    expect(a?.context_description).toBe("First context");
    expect(a?.tags).toEqual(["alpha", "zeta"]); // sorted
    expect(a?.siblings.map((s) => s.document_id)).toEqual([ID_B]); // sorted by title
    expect(a?.matched_text).toBe("alpha match");
    expect(a?.score).toBe(0.987654);

    const b = byId.get(ID_B);
    expect(b?.title).toBe("Beta Doc");
    expect(b?.tags).toEqual([]);
    expect(b?.siblings.map((s) => s.document_id)).toEqual([ID_A]);
    expect(b?.matched_text).toBeNull();
    expect(b?.score).toBe(0.5);
  });
});
