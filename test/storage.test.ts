import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, metadataHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import type { ParsedNote } from "../src/types.js";
import { RESERVED_METADATA_KEY } from "../src/types.js";

// Ports legacy/python/tests/test_storage.py — SQL/semantic parity with
// storage.py is what keeps the golden-query scores at 9/10 (see
// .superpowers/sdd/ts-task-7-brief.md).

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

function count(conn: Database.Database, table: string): number {
  return (conn.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

describe("db/storage", () => {
  let conn: Database.Database;
  let provider: FakeProvider;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
  });

  afterEach(() => {
    conn.close();
  });

  it("upsert writes all tables", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);

    expect(count(conn, "documents")).toBe(1);
    expect(count(conn, "documents_fts")).toBe(1);
    expect(count(conn, "chunks")).toBeGreaterThanOrEqual(1);
    expect(count(conn, "chunks_vec")).toBeGreaterThanOrEqual(1);
    const tags = new Set(
      (conn.prepare("SELECT tag FROM tags").all() as { tag: string }[]).map((r) => r.tag),
    );
    expect(tags).toEqual(new Set(["networking", "ssl"]));
    const row = conn.prepare("SELECT value FROM metadata WHERE key='status'").get() as {
      value: string;
    };
    expect(row.value).toBe("resolved");
  });

  it("re-upsert replaces, not duplicates", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    await ingestOne(conn, provider, makeNote({ body: "# Traefik\n\nCompletely new body." }));

    expect(count(conn, "documents")).toBe(1);
    expect(count(conn, "documents_fts")).toBe(1);
    const orphans = (
      conn
        .prepare("SELECT COUNT(*) c FROM chunks_vec WHERE chunk_id NOT IN (SELECT id FROM chunks)")
        .get() as { c: number }
    ).c;
    expect(orphans).toBe(0);
  });

  it("delete removes everything", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    new Storage(conn).delete(note.id);

    for (const table of [
      "documents",
      "documents_fts",
      "chunks",
      "chunks_vec",
      "tags",
      "metadata",
    ]) {
      expect(count(conn, table), table).toBe(0);
    }
  });

  it("content hash roundtrips", async () => {
    const note = makeNote();
    const s = new Storage(conn);
    expect(s.getContentHash(note.id)).toBeNull();
    await ingestOne(conn, provider, note);
    expect(s.getContentHash(note.id)).toBe(contentHash(note.body));
  });

  it("checks embedding config", () => {
    const s = new Storage(conn);
    expect(s.checkEmbeddingConfig("fake-8d", 8)).toBe(true); // first call records
    expect(s.checkEmbeddingConfig("fake-8d", 8)).toBe(true); // same -> ok
    expect(s.checkEmbeddingConfig("other-model", 8)).toBe(false);
  });

  it("update_metadata_if_changed is a no-op when nothing changed", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    const beforeChanges = conn.prepare("SELECT total_changes() c").get() as { c: number };
    const beforeIndexedAt = (
      conn.prepare("SELECT indexed_at FROM documents WHERE id = ?").get(note.id) as {
        indexed_at: string;
      }
    ).indexed_at;

    const changed = s.updateMetadataIfChanged(note, contentHash(note.body));

    expect(changed).toBe(false);
    const afterChanges = conn.prepare("SELECT total_changes() c").get() as { c: number };
    expect(afterChanges.c).toBe(beforeChanges.c);
    const afterIndexedAt = (
      conn.prepare("SELECT indexed_at FROM documents WHERE id = ?").get(note.id) as {
        indexed_at: string;
      }
    ).indexed_at;
    expect(afterIndexedAt).toBe(beforeIndexedAt);
  });

  it("update_metadata_if_changed writes when metadata changed", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    const beforeChanges = (conn.prepare("SELECT total_changes() c").get() as { c: number }).c;
    const updated = makeNote({
      title: "Traefik Cert Renewal (updated)",
      tags: ["networking", "ssl", "renewed"],
    });

    const changed = s.updateMetadataIfChanged(updated, contentHash(updated.body));

    expect(changed).toBe(true);
    const afterChanges = (conn.prepare("SELECT total_changes() c").get() as { c: number }).c;
    expect(afterChanges).toBeGreaterThan(beforeChanges);
    const row = conn.prepare("SELECT title FROM documents WHERE id = ?").get(note.id) as {
      title: string;
    };
    expect(row.title).toBe("Traefik Cert Renewal (updated)");
    const tags = new Set(
      (
        conn.prepare("SELECT tag FROM tags WHERE document_id = ?").all(note.id) as {
          tag: string;
        }[]
      ).map((r) => r.tag),
    );
    expect(tags).toEqual(new Set(["networking", "ssl", "renewed"]));
    const ftsTitle = (
      conn.prepare("SELECT title FROM documents_fts WHERE doc_id = ?").get(note.id) as {
        title: string;
      }
    ).title;
    expect(ftsTitle).toBe("Traefik Cert Renewal (updated)");
  });

  it("metadata_hash distinguishes ambiguous tag splits", () => {
    const one = makeNote({ tags: ["a,b"] });
    const two = makeNote({ tags: ["a", "b"] });
    expect(metadataHash(one)).not.toBe(metadataHash(two));
  });

  it("metadata_hash distinguishes ambiguous extra_metadata splits", () => {
    const one = makeNote({ extraMetadata: { a: "b,c=d" } });
    const two = makeNote({ extraMetadata: { a: "b", c: "d" } });
    expect(metadataHash(one)).not.toBe(metadataHash(two));

    // Sanity check on the premise: confirm these two truly collide under a
    // naive comma/equals join, so the assertion above is a real regression
    // guard and not just two arbitrary distinct dicts.
    const naiveJoin = (m: Record<string, string>) =>
      Object.entries(m)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
    expect(naiveJoin(one.extraMetadata)).toBe(naiveJoin(two.extraMetadata));
  });

  it("update_metadata_if_changed applies an ambiguous tag edit", async () => {
    const note = makeNote({ tags: ["a", "b"] });
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    const edited = makeNote({ tags: ["a,b"] });

    const changed = s.updateMetadataIfChanged(edited, contentHash(edited.body));

    expect(changed).toBe(true);
    const tags = new Set(
      (
        conn.prepare("SELECT tag FROM tags WHERE document_id = ?").all(note.id) as {
          tag: string;
        }[]
      ).map((r) => r.tag),
    );
    expect(tags).toEqual(new Set(["a,b"]));
  });

  it("upsert filters the reserved metadata key directly", async () => {
    const note = makeNote({ extraMetadata: { [RESERVED_METADATA_KEY]: "injected-fake-hash" } });
    await expect(ingestOne(conn, provider, note)).resolves.not.toThrow();

    const stored = (
      conn
        .prepare("SELECT value FROM metadata WHERE document_id = ? AND key = ?")
        .get(note.id, RESERVED_METADATA_KEY) as { value: string }
    ).value;
    expect(stored).toBe(metadataHash(note));
    expect(stored).not.toBe("injected-fake-hash");
  });

  it("clear_content_hash forces the re-embed path", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    expect(s.getContentHash(note.id)).toBe(contentHash(note.body));

    s.clearContentHash(note.id);

    expect(s.getContentHash(note.id)).toBe("");
  });

  it("context descriptions and stats", async () => {
    await ingestOne(conn, provider, makeNote());
    const s = new Storage(conn);
    s.setContextDescription("homelab-traefik", "Reverse proxy and cert notes");
    let rows = s.listContexts();
    expect(rows).toEqual([
      { context: "homelab-traefik", count: 1, description: "Reverse proxy and cert notes" },
    ]);
    s.setContextDescription("homelab-traefik", null);
    rows = s.listContexts();
    expect(rows[0]?.description).toBeNull();
    const st = s.stats();
    expect(st.documents).toBe(1);
    expect(st.chunks).toBeGreaterThanOrEqual(1);
  });

  it("set_context_description normalizes the context", async () => {
    await ingestOne(conn, provider, makeNote({ context: "homelab" }));
    const s = new Storage(conn);

    s.setContextDescription("  Homelab  ", "x");

    const row = conn
      .prepare("SELECT description FROM context_descriptions WHERE context = ?")
      .get("homelab") as { description: string } | undefined;
    expect(row?.description).toBe("x");
    const rawCount = (
      conn
        .prepare("SELECT COUNT(*) c FROM context_descriptions WHERE context = ?")
        .get("  Homelab  ") as { c: number }
    ).c;
    expect(rawCount).toBe(0);
  });

  it("set_context_description rejects empty after normalization", () => {
    const s = new Storage(conn);
    expect(() => s.setContextDescription("   ", "x")).toThrow();
  });

  it("all_metadata_hashes returns stored hashes", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);

    const hashes = s.allMetadataHashes();

    expect(hashes).toEqual({ [note.id]: metadataHash(note, "Notes") });
    expect(hashes[note.id]).toBe(s.getMetadataHash(note.id));
  });

  it("update_metadata_if_changed uses the precomputed hash without a SELECT", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    const metaHashes = s.allMetadataHashes();
    const beforeChanges = (conn.prepare("SELECT total_changes() c").get() as { c: number }).c;

    const spy = vi.spyOn(s, "getMetadataHash");
    const changed = s.updateMetadataIfChanged(
      note,
      contentHash(note.body),
      metaHashes[note.id] ?? null,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(changed).toBe(false);
    const afterChanges = (conn.prepare("SELECT total_changes() c").get() as { c: number }).c;
    expect(afterChanges).toBe(beforeChanges);
    spy.mockRestore();
  });

  it("stored_embedding_config roundtrips", () => {
    const s = new Storage(conn);
    expect(s.storedEmbeddingConfig()).toBeNull(); // fresh DB: nothing committed
    s.commitEmbeddingConfig("fake-8d", 8);
    expect(s.storedEmbeddingConfig()).toEqual(["fake-8d", 8]);
  });

  it("pending_chunks / write_vectors resume correctly", async () => {
    const note = makeNote();
    const chunks = chunkText(note.body);
    const s = new Storage(conn);
    // Structural-only upsert: no embeddings yet.
    s.upsert(note, contentHash(note.body), chunks, null);

    const pending = s.pendingChunks();
    expect(pending.length).toBe(chunks.length);
    expect(count(conn, "chunks_vec")).toBe(0);

    const embeddings = await provider.embed(pending.map(([, text]) => text));
    const rows: [number, number[]][] = pending.map(([id], i) => [id, embeddings[i] as number[]]);
    s.writeVectors(rows);

    expect(s.pendingChunks()).toEqual([]);
    expect(count(conn, "chunks_vec")).toBe(chunks.length);
  });

  it("mark/clear/isIngestInProgress roundtrip", () => {
    const s = new Storage(conn);
    expect(s.isIngestInProgress()).toBe(false);
    s.markIngestInProgress();
    expect(s.isIngestInProgress()).toBe(true);
    s.clearIngestInProgress();
    expect(s.isIngestInProgress()).toBe(false);
  });

  it("indexed_paths maps file_path to id", async () => {
    const note = makeNote();
    await ingestOne(conn, provider, note);
    const s = new Storage(conn);
    expect(s.indexedPaths()).toEqual({ [note.filePath]: note.id });
  });
});
