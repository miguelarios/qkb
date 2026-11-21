/** Streamable HTTP transport for the qkb MCP server (`qkb mcp --http`).
 *
 * Serves protocol revision 2026-07-28 — per request, no `initialize`
 * handshake and no `Mcp-Session-Id` — and, through the SDK's stateless
 * fallback, clients still on a 2025 revision. Either way every `POST /mcp`
 * gets a fresh `McpServer` over the one shared `QkbContext` (connection,
 * provider, lock), so there is no session table to leak and any number of
 * clients can connect — while the embedding model is still loaded only once
 * per process. Every qkb tool returns one result and sends no progress, so
 * 2026-07-28 responses are plain JSON bodies, not SSE streams.
 *
 * Also serves `GET /health` for container probes.
 *
 * DNS-rebinding guard: a browser page on some other site can make requests
 * to a server bound on localhost. Requests that carry an `Origin` header
 * (browsers always send one on cross-origin fetches) are refused unless the
 * origin is loopback or listed in `mcp.allowed_origins` /
 * `QKB_ALLOWED_ORIGINS` (`*` disables the check). Non-browser MCP clients
 * send no `Origin` and are unaffected.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Storage } from "../db/storage.js";
import { createMcpServer, type QkbContext } from "./mcp.js";

/** Largest JSON-RPC request body accepted. qkb requests are tiny. */
const MAX_BODY_BYTES = 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined || origin === "") return true;
  if (allowed.includes("*") || allowed.includes(origin)) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

export interface HttpServerOptions {
  host: string;
  port: number;
  allowedOrigins: string[];
}

export interface RunningHttpServer {
  server: Server;
  /** Base URL actually bound (useful with port 0). */
  url: string;
  close(): Promise<void>;
}

/** Start serving `ctx` over HTTP. Resolves once the port is bound. Does not
 * own `ctx` — the caller closes it after `close()`. */
export async function startHttpServer(
  ctx: QkbContext,
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  const logError = (e: Error): void => console.error(`qkb: MCP request failed: ${e.message}`);
  const mcp = createMcpHandler(() => createMcpServer(ctx), {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: logError,
  });
  const handleMcp = toNodeHandler(mcp, { onerror: logError, maxRequestBodySize: MAX_BODY_BYTES });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const origin = req.headers.origin;
        if (!originAllowed(origin, options.allowedOrigins)) {
          jsonRpcError(res, 403, -32000, `Origin not allowed: ${origin}`);
          return;
        }
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path === "/health" && req.method === "GET") {
          const documents = await ctx.withLock(() => new Storage(ctx.conn).stats().documents);
          sendJson(res, 200, { status: "ok", documents });
          return;
        }
        if (path !== "/mcp") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        // GET (standalone stream) and DELETE (end a session) have nothing to
        // act on in a stateless server; the handler answers them 405.
        await handleMcp(req, res);
      } catch (e) {
        console.error(`qkb: HTTP request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, "Internal server error");
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const hostForUrl = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return {
    server,
    url: `http://${hostForUrl}:${addr.port}`,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
