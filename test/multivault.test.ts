import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, configuredVaults, loadConfig, vaultPathFor } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { Storage } from "../src/db/storage.js";
import { FakeProvider } from "../src/embed/fake.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { Filters } from "../src/search/filters.js";
import { getDocument } from "../src/search/retrieval.js";
import { executeSearch } from "../src/search/service.js";

// Multiple vaults in one index (#23). Note ids are globally unique; file
// paths are unique per vault.

const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";
const ID3 = "f47ac10b-58cc-4372-a567-0e02b2c3d403";

function note(dir: string, name: string, id: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    `---\nid: ${id}\ncontext: homelab-traefik\ncreated: 2026-01-01\n---\n\n${body}\n`,
  );
}

describe("multiple vaults", () => {
  let tmp: string;
  let cfg: Config;
  let personal: string;
  let wiki: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-vaults-"));
    personal = join(tmp, "personal");
    wiki = join(tmp, "wiki");
    mkdirSync(personal);
    mkdirSync(wiki);
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaults = [
      { name: "Personal", path: personal },
      { name: "Wiki", path: wiki },
    ];
    cfg.dbPath = join(tmp, "qkb.db");
    cfg.embeddingProvider = "fake";
    cfg.embeddingDim = 8;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function ingest() {
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    const skips: [string, string][] = [];
    const stats = await ingestVault(conn, cfg, {
      provider: new FakeProvider(cfg.embeddingDim),
      onSkip: (p, r) => skips.push([p, r]),
    });
    return { conn, stats, skips };
  }

  function search(conn: ReturnType<typeof connect>, q: string, vaults?: string[]) {
    return executeSearch(
      conn,
      cfg,
      new FakeProvider(cfg.embeddingDim),
      q,
      new Filters({ vaults }),
      null,
      "bm25",
    );
  }

  it("indexes every vault and records which vault each note came from", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(wiki, "a.md", ID2, "Traefik routing rules.");
    const { conn, stats } = await ingest();
    expect(stats.indexed).toBe(2);

    const hits = await search(conn, "traefik");
    expect(hits.map((h) => [h.document_id, h.vault]).sort()).toEqual([
      [ID1, "Personal"],
      [ID2, "Wiki"],
    ]);
    // Same relative path in both vaults; each URI names its own vault.
    const uris = Object.fromEntries(hits.map((h) => [h.vault, h.obsidian_uri]));
    expect(uris.Personal).toContain("vault=Personal");
    expect(uris.Wiki).toContain("vault=Wiki");
    expect(new Storage(conn).vaultCounts()).toEqual([
      { vault: "Personal", documents: 1 },
      { vault: "Wiki", documents: 1 },
    ]);
    conn.close();
  });

  it("filters results to the requested vaults", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(wiki, "b.md", ID2, "Traefik routing rules.");
    const { conn } = await ingest();
    expect((await search(conn, "traefik", ["Wiki"])).map((h) => h.document_id)).toEqual([ID2]);
    expect(await search(conn, "traefik", ["Personal", "Wiki"])).toHaveLength(2);
    expect(await search(conn, "traefik", ["Nope"])).toHaveLength(0);
    conn.close();
  });

  it("keeps ids unique across vaults: a second vault's copy is a reported duplicate", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(wiki, "mirror.md", ID1, "Traefik certificate renewal.");
    const { conn, stats, skips } = await ingest();
    expect(stats.indexed).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(skips[0]?.[1]).toMatch(/^duplicate id/);
    conn.close();
  });

  it("sweeps deletions per vault, only after every vault was walked", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(personal, "b.md", ID3, "Kept.");
    note(wiki, "b.md", ID2, "Traefik routing rules.");
    (await ingest()).conn.close();

    unlinkSync(join(personal, "a.md"));
    const { conn, stats } = await ingest();
    expect(stats.deindexed).toBe(1);
    expect((await search(conn, "renewal")).map((h) => h.document_id)).toEqual([]);
    expect(new Storage(conn).vaultCounts()).toEqual([
      { vault: "Personal", documents: 1 },
      { vault: "Wiki", documents: 1 },
    ]);
    conn.close();
  });

  it("follows a note that moved to another vault without re-embedding it", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(personal, "keep.md", ID3, "Kept.");
    note(wiki, "b.md", ID2, "Other.");
    (await ingest()).conn.close();

    unlinkSync(join(personal, "a.md"));
    note(wiki, "moved.md", ID1, "Traefik certificate renewal.");
    const { conn, stats } = await ingest();
    expect(stats.deindexed).toBe(0);
    expect(stats.unchanged).toBe(3); // body unchanged: metadata-only refresh
    const hit = (await search(conn, "certificate"))[0];
    expect(hit?.vault).toBe("Wiki");
    expect(hit?.file_path).toBe("moved.md");
    conn.close();
  });

  it("de-indexes notes of a vault removed from the config", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(wiki, "b.md", ID2, "Traefik routing rules.");
    (await ingest()).conn.close();

    cfg.vaults = [{ name: "Personal", path: personal }];
    const { conn, stats } = await ingest();
    expect(stats.deindexed).toBe(1);
    expect(new Storage(conn).vaultCounts()).toEqual([{ vault: "Personal", documents: 1 }]);
    conn.close();
  });

  it("refuses to wipe a vault that suddenly has no notes (unmounted volume)", async () => {
    note(personal, "a.md", ID1, "Traefik certificate renewal.");
    note(wiki, "b.md", ID2, "Traefik routing rules.");
    (await ingest()).conn.close();

    unlinkSync(join(wiki, "b.md"));
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await expect(ingestVault(conn, cfg)).rejects.toThrow(/is it mounted/);
    expect(new Storage(conn).vaultCounts()).toHaveLength(2);
    conn.close();
  });

  it("qkb get reads the raw file from the note's own vault", async () => {
    note(personal, "a.md", ID1, "Personal body.");
    note(wiki, "a.md", ID2, "Wiki body.");
    const { conn } = await ingest();
    const doc = getDocument(conn, ID2, (name) => vaultPathFor(cfg, name), true);
    expect(doc.vault).toBe("Wiki");
    expect(doc.raw_text).toContain("Wiki body.");
    conn.close();
  });
});

describe("[[vaults]] config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-vaultcfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function load(toml: string, env: Record<string, string> = {}) {
    const p = join(tmp, "config.toml");
    writeFileSync(p, toml);
    return loadConfig(p, env);
  }

  it("a single [vault] still means one vault", () => {
    const cfg = load('[vault]\npath = "/data/notes"\nname = "Notes"\n');
    expect(configuredVaults(cfg)).toEqual([{ name: "Notes", path: "/data/notes" }]);
  });

  it("[[vaults]] lists several; name defaults to the directory name", () => {
    const cfg = load(
      '[[vaults]]\nname = "Personal"\npath = "/data/personal"\n\n[[vaults]]\npath = "/data/agent-wiki"\n',
    );
    expect(configuredVaults(cfg)).toEqual([
      { name: "Personal", path: "/data/personal" },
      { name: "agent-wiki", path: "/data/agent-wiki" },
    ]);
    expect(cfg.vaultName).toBe("Personal");
  });

  it("rejects duplicate vault names and entries without a path", () => {
    expect(() => load('[[vaults]]\npath = "/a/x"\n[[vaults]]\npath = "/b/x"\n')).toThrow(
      /duplicate vault name/,
    );
    expect(() => load('[[vaults]]\nname = "x"\n')).toThrow(/needs a `path`/);
  });

  it("QKB_VAULT_PATH replaces a configured [[vaults]] list", () => {
    const cfg = load('[[vaults]]\npath = "/data/personal"\n', { QKB_VAULT_PATH: "/data/other" });
    expect(configuredVaults(cfg)).toEqual([{ name: "Notes", path: "/data/other" }]);
  });
});
