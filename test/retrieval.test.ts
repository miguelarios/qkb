import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/db/schema.js";
import { contentHash, Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { chunkText } from "../src/ingest/chunker.js";
import {
  DocumentFileMissing,
  DocumentNotFoundError,
  getDocument,
} from "../src/search/retrieval.js";
import type { ParsedNote } from "../src/types.js";

// Ports legacy/python/tests/test_retrieval.py — get-by-id/prefix, typed
// errors for missing/dir/ambiguous, raw utf-8 file reads, and LIKE-escaping
// of literal `%`/`_` in a prefix.

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

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("search/retrieval getDocument", () => {
  let conn: Database.Database;
  let provider: FakeProvider;
  let tmpDir: string;

  beforeEach(() => {
    conn = connect(":memory:", DIM);
    provider = new FakeProvider(DIM);
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-retrieval-test-"));
  });

  afterEach(() => {
    conn.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("gets by prefix and reads the raw file (ports test_get_by_prefix_and_raw)", async () => {
    const vault = join(tmpDir, "vault");
    const notePath = join(vault, "02-Areas/Homelab/Traefik Cert Renewal.md");
    mkdirSync(join(vault, "02-Areas/Homelab"), { recursive: true });
    writeFileSync(notePath, "---\nid: x\n---\n\nThe body on disk.\n");
    await ingestOne(conn, provider, makeNote({ id: ID_A }));

    const doc = getDocument(conn, "aaaaaaaa", vault, true);
    expect(doc.document_id).toBe(ID_A);
    expect(doc.raw_text).toContain("The body on disk.");
  });

  it("missing prefix raises typed not-found; ambiguous prefix raises typed ambiguous error (ports test_get_missing_and_ambiguous)", async () => {
    await ingestOne(conn, provider, makeNote({ id: ID_A }));
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "aaaaaaaa-ffff-4fff-8fff-ffffffffffff",
        filePath: "other.md",
        context: "personal",
      }),
    );
    expect(() => getDocument(conn, "zzzz")).toThrow(DocumentNotFoundError);
    expect(() => getDocument(conn, "aaaaaaaa")).toThrow(/ambiguous/i);
  });

  it("a note moved/renamed since ingest raises a typed, catchable error (ports test_get_raw_missing_file_raises_typed_error)", async () => {
    const vault = join(tmpDir, "vault");
    mkdirSync(vault, { recursive: true });
    await ingestOne(conn, provider, makeNote({ id: ID_A })); // file_path never written to vault

    let caught: unknown;
    try {
      getDocument(conn, "aaaaaaaa", vault, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocumentFileMissing);
    const message = String((caught as Error).message).toLowerCase();
    expect(message.includes("re-ingest") || message.includes("ingest")).toBe(true);
    expect(message.includes("moved") || message.includes("deleted")).toBe(true);
  });

  it("reads utf-8 non-ASCII content without mangling (ports test_get_raw_reads_utf8_non_ascii)", async () => {
    const vault = join(tmpDir, "vault");
    const notePath = join(vault, "02-Areas/Homelab/Traefik Cert Renewal.md");
    mkdirSync(join(vault, "02-Areas/Homelab"), { recursive: true });
    const nonAsciiBody = "# Café notes — café, ümläut, \u{1f600}\n";
    writeFileSync(notePath, nonAsciiBody, { encoding: "utf-8" });
    await ingestOne(conn, provider, makeNote({ id: ID_A }));

    const doc = getDocument(conn, "aaaaaaaa", vault, true);
    expect(doc.raw_text).toContain(nonAsciiBody);
  });

  it("a directory sitting where the file should be raises a typed error, not a bare OSError (ports test_get_raw_file_path_is_directory_raises_typed_error)", async () => {
    const vault = join(tmpDir, "vault");
    const notePath = join(vault, "02-Areas/Homelab/Traefik Cert Renewal.md");
    mkdirSync(notePath, { recursive: true }); // a directory sits where the file should be
    await ingestOne(conn, provider, makeNote({ id: ID_A }));

    let caught: unknown;
    try {
      getDocument(conn, "aaaaaaaa", vault, true);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocumentFileMissing);
    const message = String((caught as Error).message).toLowerCase();
    expect(message).toContain("cannot read");
  });

  it("a literal '%' prefix does not match every document (ports test_get_percent_prefix_does_not_match_all)", async () => {
    await ingestOne(conn, provider, makeNote({ id: ID_A }));
    await ingestOne(
      conn,
      provider,
      makeNote({
        id: "aaaaaaaa-ffff-4fff-8fff-ffffffffffff",
        filePath: "other.md",
        context: "personal",
      }),
    );

    expect(() => getDocument(conn, "%")).toThrow(DocumentNotFoundError);
  });

  it("a literal '_' prefix does not wildcard-match a single char (ports test_get_underscore_prefix_does_not_wildcard_match)", async () => {
    await ingestOne(conn, provider, makeNote({ id: ID_A }));

    expect(() => getDocument(conn, "_aaaaaaa")).toThrow(DocumentNotFoundError);
  });
});
