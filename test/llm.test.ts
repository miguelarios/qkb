import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { FakeProvider } from "../src/embed/fake.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { FakeExpander, parseVariants, type QueryExpander } from "../src/llm/expand.js";
import { blendScore, FakeReranker, type Reranker } from "../src/llm/rerank.js";
import { Filters } from "../src/search/filters.js";
import { executeSearch } from "../src/search/service.js";

// Optional model stages (#37 reranking, #38 query expansion), exercised with
// the offline fakes. The real GGUF models run only in test/integration/.

describe("blendScore", () => {
  it("trusts retrieval more at the top of the list", () => {
    // A strong rerank score can lift rank 11 over a weakly-reranked rank 4…
    expect(blendScore(11, 1)).toBeGreaterThan(blendScore(4, 0));
    // …but a zero-scored rank 1 still beats a perfect rank 5.
    expect(blendScore(1, 0)).toBeGreaterThan(blendScore(5, 1));
    expect(blendScore(1, 1)).toBeCloseTo(1);
  });
});

describe("parseVariants", () => {
  it("keeps lex/vec/hyde lines that share a word with the query", () => {
    const out = parseVariants(
      "renew traefik certs",
      "lex: traefik certificate renewal\nvec: how to renew a traefik cert\n" +
        "hyde: Traefik renews certs via ACME.\nlex: completely unrelated\n" +
        "garbage line\nlex: renew traefik certs\n",
      10,
    );
    expect(out).toEqual([
      { type: "lex", text: "traefik certificate renewal" },
      { type: "vec", text: "how to renew a traefik cert" },
      { type: "vec", text: "Traefik renews certs via ACME." },
    ]);
  });

  it("caps the number of variants", () => {
    expect(
      parseVariants("a traefik", "lex: traefik 1\nlex: traefik 2\nlex: traefik 3", 2),
    ).toHaveLength(2);
  });
});

describe("search with optional model stages", () => {
  let tmp: string;
  let cfg: Config;
  const provider = new FakeProvider(8);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-llm-"));
    cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
    cfg.vaultPath = join(tmp, "vault");
    mkdirSync(cfg.vaultPath);
    cfg.dbPath = join(tmp, "qkb.db");
    cfg.embeddingProvider = "fake";
    cfg.embeddingDim = 8;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function note(id: string, body: string): void {
    writeFileSync(join(cfg.vaultPath, `${id}.md`), `---\nid: ${id}\n---\n\n${body}\n`);
  }

  async function run(
    query: string,
    extras: { reranker?: Reranker; expander?: QueryExpander; onWarning?: (m: string) => void },
  ): Promise<string[]> {
    const conn = connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider });
    const hits = await executeSearch(
      conn,
      cfg,
      provider,
      query,
      new Filters(),
      null,
      "hybrid",
      extras,
    );
    conn.close();
    return hits.map((h) => h.document_id);
  }

  it("the reranker lifts a deep candidate it likes", async () => {
    for (let i = 0; i < 12; i++) note(`n${i}`, `Zephyr rollout note ${i}.`.repeat(i + 1));
    note("liked", "Zephyr owners.");
    const plain = await run("zephyr rollout", {});
    const picky: Reranker = {
      modelName: "picky",
      rank: async (_q, docs) => docs.map((d) => (d.includes("owners") ? 1 : 0)),
    };
    const reranked = await run("zephyr rollout", { reranker: picky });
    expect(plain.slice(0, 2)).not.toContain("liked");
    // Retrieval's #1 keeps its place; the liked note comes right after it.
    expect(reranked.slice(0, 2)).toEqual([plain[0], "liked"]);
  });

  it("the reranker sees the note's title and a passage", async () => {
    note("a", "Zephyr rollout details.");
    const seen: string[] = [];
    await run("zephyr", {
      reranker: {
        modelName: "spy",
        rank: async (_q, docs) => {
          seen.push(...docs);
          return docs.map(() => 0.5);
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("a"); // title falls back to the file name
    expect(seen[0]).toContain("Zephyr rollout details.");
  });

  it("the fake reranker scores by query-word overlap", async () => {
    expect(await new FakeReranker().rank("alpha beta", ["alpha beta", "alpha", "gamma"])).toEqual([
      1, 0.5, 0,
    ]);
  });

  it("expansion brings in notes matching a rewrite of the query", async () => {
    note("target", "Certificate renewal runbook.");
    for (let i = 0; i < 8; i++) note(`other${i}`, `Unrelated grocery list ${i}.`);
    const expander = new FakeExpander({ ssl: ["certificate"] });
    // "ssl" matches no word, so BM25 contributes nothing without expansion;
    // with it, the lex rewrite's BM25 hit puts the runbook first.
    expect((await run("ssl", { expander }))[0]).toBe("target");
  });

  it("a failing stage falls back to plain search with a warning", async () => {
    note("a", "Zephyr rollout details.");
    const warnings: string[] = [];
    const hits = await run("zephyr", {
      expander: {
        modelName: "broken",
        expand: async () => {
          throw new Error("model missing");
        },
      },
      reranker: {
        modelName: "broken",
        rank: async () => {
          throw new Error("out of memory");
        },
      },
      onWarning: (m) => warnings.push(m),
    });
    expect(hits).toEqual(["a"]);
    expect(warnings).toEqual([
      "query expansion failed, searching without it: model missing",
      "reranking failed, returning unreranked results: out of memory",
    ]);
  });
});
