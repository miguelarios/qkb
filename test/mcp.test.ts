import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import * as schema from "../src/db/schema.js";
import { FakeProvider } from "../src/embed/fake.js";
import * as embedProvider from "../src/embed/provider.js";
import { ingestVault } from "../src/ingest/pipeline.js";
import { buildServer } from "../src/server/mcp.js";

// Ports legacy/python/tests/test_mcp.py — drives the qkb MCP server
// in-process over a linked InMemoryTransport pair (client <-> server),
// since this SDK's McpServer has no direct call_tool()/list_tools() the way
// Python's FastMCP does. Every assertion targets the same JSON payload
// values test_mcp.py checks; only the driving mechanics differ (see the
// task brief/report for why).

vi.mock("../src/embed/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embed/provider.js")>();
  return { ...actual, getProvider: vi.fn(actual.getProvider) };
});

vi.mock("../src/db/schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/schema.js")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});

const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";

interface WriteOpts {
  body?: string;
  extra?: string;
}

function writeNote(vault: string, name: string, noteId: string, opts: WriteOpts = {}): string {
  const { body = "Some body text.", extra = "" } = opts;
  const p = join(vault, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    `---\nid: ${noteId}\ncontext: homelab\ncreated: 2026-01-01T00:00:00-06:00\n${extra}---\n\n${body}\n`,
  );
  return p;
}

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

/** Connect a Client to `server` over a fresh in-memory transport pair —
 * mirrors what a real MCP client (e.g. Claude Desktop) does over stdio,
 * minus the process boundary. */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Invoke an MCP tool and return its parsed JSON payload — mirrors
 * test_mcp.py's `call()` helper, which parses `result[0].text` as JSON. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "null");
}

describe("server/mcp build_server tools", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-mcp-"));
    vi.mocked(embedProvider.getProvider).mockClear();
    vi.mocked(schema.connect).mockClear();
  });

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true });
  });

  async function ingestOne(cfg: Config, path: string, id: string, body: string): Promise<void> {
    writeNote(cfg.vaultPath, path, id, { body });
    const conn = schema.connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(cfg.embeddingDim) });
    conn.close();
  }

  it("ports test_mcp_tools: tool list, qkb, qkb_get, qkb_status, rerank stub", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");

    const server = await buildServer(cfg);
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("qkb")).toBe(true);
    expect(names.has("qkb_get")).toBe(true);
    expect(names.has("qkb_status")).toBe(true);

    const searchOut = await call(client, "qkb", { query: "traefik" });
    expect(searchOut.result[0].document_id).toBe(ID1);

    const getOut = await call(client, "qkb_get", { document_id: ID1.slice(0, 8) });
    expect(getOut.document_id).toBe(ID1);

    const statusOut = await call(client, "qkb_status");
    expect(statusOut.documents).toBe(1);

    const rerankOut = await call(client, "qkb", { query: "x", rerank: true });
    expect(rerankOut).toEqual({ error: "re-ranking not configured (Phase 2)" });
  });

  it("ports test_qkb_uses_cfg_default_limit_when_omitted", async () => {
    const cfg = makeCfg(tmpPath);
    cfg.defaultLimit = 1;
    writeNote(cfg.vaultPath, "a.md", ID1, { body: "Renewing traefik certificates." });
    writeNote(cfg.vaultPath, "b.md", ID2, { body: "Renewing traefik certificates too." });
    const conn = schema.connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(cfg.embeddingDim) });
    conn.close();

    const server = await buildServer(cfg);
    const client = await connectClient(server);
    const out = await call(client, "qkb", { query: "traefik" });
    expect(out.result.length).toBe(cfg.defaultLimit);
    expect(cfg.defaultLimit).toBe(1);
  });

  it("ports test_qkb_source_filter", async () => {
    const cfg = makeCfg(tmpPath);
    writeNote(cfg.vaultPath, "a.md", ID1, {
      body: "Renewing traefik certificates.",
      extra: "source: proj-a\n",
    });
    writeNote(cfg.vaultPath, "b.md", ID2, {
      body: "Renewing traefik certificates.",
      extra: "source: proj-b\n",
    });
    const conn = schema.connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(cfg.embeddingDim) });
    conn.close();

    const server = await buildServer(cfg);
    const client = await connectClient(server);
    const out = await call(client, "qkb", { query: "traefik", source: "proj-a" });
    expect(out.result.map((r: { document_id: string }) => r.document_id)).toEqual([ID1]);
  });

  it("ports test_qkb_limit_below_one_returns_structured_error_not_exception", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");

    const server = await buildServer(cfg);
    const client = await connectClient(server);
    const out = await call(client, "qkb", { query: "traefik", limit: 0 });
    expect(out.error).toBeDefined();
    expect(out.result).toBeUndefined();
  });

  it("ports test_qkb_context_filter_whitespace_returns_top_level_error", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");

    const server = await buildServer(cfg);
    const client = await connectClient(server);
    const out = await call(client, "qkb", { query: "traefik", context: "   " });
    expect(out).toEqual({ error: "context filter is empty or whitespace-only" });
    expect(out.result).toBeUndefined();
  });

  it("ports test_qkb_get_missing_raw_file_returns_structured_error", async () => {
    const cfg = makeCfg(tmpPath);
    const notePath = writeNote(cfg.vaultPath, "a.md", ID1, {
      body: "Renewing traefik certificates.",
    });
    const conn = schema.connect(cfg.dbPath, cfg.embeddingDim);
    await ingestVault(conn, cfg, { provider: new FakeProvider(cfg.embeddingDim) });
    conn.close();
    unlinkSync(notePath);

    const server = await buildServer(cfg);
    const client = await connectClient(server);
    const out = await call(client, "qkb_get", { document_id: ID1.slice(0, 8), include_raw: true });
    expect(out.error).toBeDefined();
    expect(String(out.error).toLowerCase()).toContain("qkb ingest");
  });

  it("ports test_provider_constructed_once_and_reused_across_calls", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");

    const server = await buildServer(cfg);
    expect(vi.mocked(embedProvider.getProvider).mock.calls.length).toBe(1);
    const client = await connectClient(server);
    await call(client, "qkb", { query: "traefik" });
    await call(client, "qkb", { query: "traefik" });
    expect(vi.mocked(embedProvider.getProvider).mock.calls.length).toBe(1);
  });

  it("ports test_lifespan_closes_provider_and_connection", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");

    const closed = { provider: false };
    class ClosingFakeProvider extends FakeProvider {
      close(): void {
        closed.provider = true;
      }
    }
    vi.mocked(embedProvider.getProvider).mockImplementationOnce(async (c) =>
      Promise.resolve(new ClosingFakeProvider(c.embeddingDim)),
    );
    // ingestOne opened (and closed) its own setup connection above via
    // schema.connect — clear that call before buildServer so `mock.results[0]`
    // below is unambiguously buildServer's connection, not ingestOne's
    // already-closed one (see test_connection_built_once_no_per_call_bootstrap
    // for the same pattern).
    vi.mocked(schema.connect).mockClear();

    const server = await buildServer(cfg);
    // schema.connect's mock wraps the real implementation (see the vi.mock
    // factory above), so buildServer's connection is both real AND captured
    // here via the spy's recorded return value.
    const captured = vi.mocked(schema.connect).mock.results[0]?.value as Database.Database;

    // No higher-level test hook exists for "the transport disconnected" in
    // this SDK (mirrors test_mcp.py's own comment: it drives FastMCP's
    // lifespan context manager directly for the same reason). Driving the
    // `onclose` callback directly is the closest equivalent — it's exactly
    // what `Protocol#close()` invokes once a real transport tears down.
    server.server.onclose?.();

    expect(closed.provider).toBe(true);
    expect(() => captured.prepare("SELECT 1").get()).toThrow();
  });

  it("ports test_connection_built_once_no_per_call_bootstrap", async () => {
    const cfg = makeCfg(tmpPath);
    await ingestOne(cfg, "a.md", ID1, "Renewing traefik certificates.");
    // ingestOne opened its own setup connection above (via schema.connect) —
    // clear that call before measuring buildServer's own bootstrap, mirroring
    // Python's fixture-vs-`with patch(...)` separation (the Python test's
    // ingest happens before the `with patch("qkb.server.mcp.connect", ...)`
    // block even starts recording).
    vi.mocked(schema.connect).mockClear();

    const server = await buildServer(cfg);
    expect(vi.mocked(schema.connect).mock.calls.length).toBe(1);
    const client = await connectClient(server);
    await call(client, "qkb", { query: "traefik" });
    await call(client, "qkb_get", { document_id: ID1.slice(0, 8) });
    await call(client, "qkb_status");
    expect(vi.mocked(schema.connect).mock.calls.length).toBe(1);
  });
});
