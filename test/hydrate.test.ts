import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import { hydrate, obsidianUri } from "../src/search/hydrate.js";
import type { ParsedNote } from "../src/types.js";
import { type NoteOverrides, withProps } from "./helpers/note.js";

// Ports legacy/python/tests/test_results.py — result-dict shape, sibling
// surfacing (related notes: wikilinks + shared source), and Obsidian URI construction. Key naming:
// hydrated result objects keep Python's snake_case dict keys verbatim
// (document_id, effective_date, obsidian_uri,
// matched_text) so JSON serialized by the CLI/MCP layers (Tasks 15/16) is
// byte-identical to Python's `json.dumps(results, indent=2)` output without a
// remapping step.

const DIM = 8;

function makeNote(overrides: NoteOverrides = {}): ParsedNote {
  const base: ParsedNote = {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d401",
    type: "note",
    title: "Traefik Cert Renewal",
    effectiveDate: "2026-03-15",
    createdAt: "2026-03-15T10:00:00-06:00",
    tags: ["networking", "ssl"],
    extraMetadata: { status: "resolved" },
    body: "# Traefik\n\nRenewing certificates requires restarting the proxy container.",
    filePath: "02-Areas/Homelab/Traefik Cert Renewal.md",
  };
  return withProps(base, overrides, { context: "homelab-traefik", source: null });
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

  it("hydrates a result with notes sharing its source as related (ports test_hydrate_with_siblings)", async () => {
    await seedSiblings(conn, provider);
    const out = hydrate(conn, [[ID_T, 0.9, "roadmap chunk"]]);
    expect(out.length).toBe(1);
    const r = out[0];
    expect(r?.title).toBe("Kickoff Transcript");
    expect(r?.matched_text).toBe("roadmap chunk");
    expect(r?.obsidian_uri.startsWith("obsidian://open?vault=Notes&file=")).toBe(true);
    expect(r?.related.map((x) => [x.document_id, x.relation])).toEqual([[ID_N, "same_source"]]);
  });

  it("no source and no links -> no related notes", async () => {
    await ingestOne(conn, provider, makeNote({ id: ID_T, source: null }));
    const out = hydrate(conn, [[ID_T, 0.5, null]]);
    expect(out[0]?.related).toEqual([]);
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
    expect(c?.tags).toEqual(["gamma"]);
    expect(c?.related).toEqual([]);
    expect(c?.matched_text).toBe("gamma match");
    expect(c?.score).toBe(0.123457);

    const a = byId.get(ID_A);
    expect(a?.tags).toEqual(["alpha", "zeta"]); // sorted
    expect(a?.related.map((x) => x.document_id)).toEqual([ID_B]);
    expect(a?.score).toBe(0.987654);

    const b = byId.get(ID_B);
    expect(b?.related.map((x) => x.document_id)).toEqual([ID_A]);
    expect(b?.matched_text).toBeNull();
    expect(b?.score).toBe(0.5);
  });

  describe("related notes from wikilinks (#36)", () => {
    const HUB = "11111111-1111-4111-8111-111111111111";
    const LEAF = "22222222-2222-4222-8222-222222222222";
    const ALIASED = "33333333-3333-4333-8333-333333333333";

    async function seed(): Promise<void> {
      await ingestOne(
        conn,
        provider,
        makeNote({
          id: HUB,
          title: "Hub",
          filePath: "Hub.md",
          links: ["Projects/Leaf", "Nick"],
          body: "See [[Projects/Leaf#Plan|the plan]] and ![[Nick]].",
        }),
      );
      await ingestOne(
        conn,
        provider,
        makeNote({ id: LEAF, title: "Leaf Note", filePath: "Projects/Leaf.md", links: [] }),
      );
      await ingestOne(
        conn,
        provider,
        makeNote({ id: ALIASED, title: "Formal Name", filePath: "Formal.md", aliases: ["Nick"] }),
      );
    }

    it("lists outgoing links (by path or alias) and backlinks", async () => {
      await seed();
      const [hub, leaf, aliased] = hydrate(conn, [
        [HUB, 1, null],
        [LEAF, 1, null],
        [ALIASED, 1, null],
      ]);
      expect(hub?.related.map((x) => [x.document_id, x.relation])).toEqual([
        [LEAF, "links_to"],
        [ALIASED, "links_to"],
      ]);
      expect(leaf?.related.map((x) => [x.document_id, x.relation])).toEqual([[HUB, "linked_from"]]);
      expect(aliased?.related.map((x) => [x.document_id, x.relation])).toEqual([
        [HUB, "linked_from"],
      ]);
    });

    it("a link to a note that doesn't exist yet resolves once the note is indexed", async () => {
      await ingestOne(
        conn,
        provider,
        makeNote({ id: HUB, title: "Hub", filePath: "Hub.md", links: ["Later"] }),
      );
      expect(hydrate(conn, [[HUB, 1, null]])[0]?.related).toEqual([]);
      await ingestOne(conn, provider, makeNote({ id: LEAF, title: "Later", filePath: "Later.md" }));
      expect(hydrate(conn, [[HUB, 1, null]])[0]?.related.map((x) => x.document_id)).toEqual([LEAF]);
    });

    it("a linked note keeps its backlink after it is renamed, as long as a link name still matches", async () => {
      await seed();
      // Moved to another folder: the [[Projects/Leaf]] path link no longer
      // matches, but its title still resolves an alias-free [[Leaf Note]] link.
      await ingestOne(
        conn,
        provider,
        makeNote({ id: HUB, title: "Hub", filePath: "Hub.md", links: ["Leaf Note"] }),
      );
      await ingestOne(
        conn,
        provider,
        makeNote({ id: LEAF, title: "Leaf Note", filePath: "Archive/Leaf.md" }),
      );
      expect(hydrate(conn, [[LEAF, 1, null]])[0]?.related.map((x) => x.document_id)).toEqual([HUB]);
    });

    it("caps related notes per search result; a single lookup returns them all", async () => {
      const targets = Array.from({ length: 12 }, (_, i) => `T${i}`);
      await ingestOne(
        conn,
        provider,
        makeNote({ id: HUB, title: "Hub", filePath: "Hub.md", links: targets }),
      );
      for (const [i, t] of targets.entries()) {
        await ingestOne(conn, provider, makeNote({ id: `t-${i}`, title: t, filePath: `${t}.md` }));
      }
      expect(hydrate(conn, [[HUB, 1, null]])[0]?.related).toHaveLength(10);
      expect(hydrate(conn, [[HUB, 1, null]], null)[0]?.related).toHaveLength(12);
    });
  });
});
