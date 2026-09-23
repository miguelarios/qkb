/** Streamable HTTP transport for the qkb MCP server (`qkb mcp --http`).
 *
 * Stateless: every `POST /mcp` gets a fresh `McpServer` + transport over the
 * one shared `QkbContext` (connection, provider, lock), so there is no
 * session table to leak and any number of clients can connect — while the
 * embedding model is still loaded only once per process. Responses are plain
 * JSON (`enableJsonResponse`), not SSE streams: every qkb tool returns one
 * result, so there is nothing to stream.
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

class BodyTooLarge extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function handleMcp(ctx: QkbContext, req: IncomingMessage, res: ServerResponse) {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      jsonRpcError(res, 413, -32600, "Request body too large");
    } else {
      jsonRpcError(res, 400, -32700, "Parse error: body is not valid JSON");
    }
    return;
  }
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
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
        if (req.method !== "POST") {
          // Stateless server: no standalone SSE stream (GET) and no session
          // to terminate (DELETE).
          res.setHeader("allow", "POST");
          jsonRpcError(res, 405, -32000, "Method not allowed");
          return;
        }
        await handleMcp(ctx, req, res);
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
