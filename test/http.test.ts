import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { connect } from "../src/db/schema.js";
import { FakeProvider } from "../src/embed/fake.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { originAllowed, type RunningHttpServer, startHttpServer } from "../src/server/http.js";
import { createContext, type QkbContext } from "../src/server/mcp.js";

// Streamable HTTP transport (#21): a real HTTP listener on an ephemeral
// loopback port, driven by the SDK's own HTTP client — no mocks between the
// client and the tool bodies.

const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";

function makeCfg(tmpPath: string): Config {
  const vault = join(tmpPath, "vault");
  mkdirSync(vault, { recursive: true });
  const cfg = loadConfig("/nonexistent/qkb-test-config.toml", {});
  cfg.vaultPath = vault;
  cfg.dbPath = join(tmpPath, "qkb.db");
  cfg.embeddingProvider = "fake";
  cfg.embeddingDim = 8;
  return cfg;
}

async function seed(cfg: Config): Promise<void> {
  writeFileSync(
    join(cfg.vaultPath, "a.md"),
    `---\nid: ${ID1}\ncontext: homelab-traefik\ncreated: 2026-01-01\n---\n\nRenewing traefik certificates.\n`,
  );
  const conn = connect(cfg.dbPath, cfg.embeddingDim);
  await ingestVault(conn, cfg, { provider: new FakeProvider(cfg.embeddingDim) });
  conn.close();
}

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "http-test-client", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "null");
}

describe("MCP over Streamable HTTP", () => {
  let tmpPath: string;
  let ctx: QkbContext;
  let http: RunningHttpServer;

  beforeEach(async () => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-http-"));
    const cfg = makeCfg(tmpPath);
    await seed(cfg);
    ctx = await createContext(cfg);
    http = await startHttpServer(ctx, { host: "127.0.0.1", port: 0, allowedOrigins: [] });
  });

  afterEach(async () => {
    await http.close();
    ctx.close();
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("initializes, lists tools, and answers a search", async () => {
    const client = await connectClient(http.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["qkb", "qkb_get", "qkb_status"]);

    const out = await call(client, "qkb", { query: "traefik" });
    expect(out.result[0].document_id).toBe(ID1);
    expect(out.result[0].vault).toBe("Notes");

    const status = await call(client, "qkb_status");
    expect(status.documents).toBe(1);
    expect(status.vaults).toEqual([{ name: "Notes", documents: 1 }]);
    await client.close();
  });

  it("serves several independent clients from one process", async () => {
    const [a, b] = await Promise.all([connectClient(http.url), connectClient(http.url)]);
    const [ra, rb] = await Promise.all([
      call(a, "qkb", { query: "traefik" }),
      call(b, "qkb_get", { document_id: ID1.slice(0, 8) }),
    ]);
    expect(ra.result[0].document_id).toBe(ID1);
    expect(rb.document_id).toBe(ID1);
    await Promise.all([a.close(), b.close()]);
  });

  it("GET /health reports ok with the document count", async () => {
    const res = await fetch(`${http.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", documents: 1 });
  });

  it("refuses a non-loopback browser Origin (DNS-rebinding guard)", async () => {
    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://evil.example.com",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects GET /mcp (stateless: no standalone stream) and unknown paths", async () => {
    expect((await fetch(`${http.url}/mcp`)).status).toBe(405);
    expect((await fetch(`${http.url}/nope`)).status).toBe(404);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe("originAllowed", () => {
  it("allows requests without an Origin (non-browser MCP clients)", () => {
    expect(originAllowed(undefined, [])).toBe(true);
  });

  it("allows loopback origins and configured ones, refuses others", () => {
    expect(originAllowed("http://localhost:3000", [])).toBe(true);
    expect(originAllowed("http://127.0.0.1:8181", [])).toBe(true);
    expect(originAllowed("http://[::1]:8181", [])).toBe(true);
    expect(originAllowed("https://notes.example.com", [])).toBe(false);
    expect(originAllowed("https://notes.example.com", ["https://notes.example.com"])).toBe(true);
    expect(originAllowed("https://anything.example.com", ["*"])).toBe(true);
    expect(originAllowed("not a url", [])).toBe(false);
  });
});
