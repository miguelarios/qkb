/** MCP server exposing qkb search to LLM agents (DESIGN.md §9.2), over stdio
 * or Streamable HTTP (`./http.ts`). Ported from
 * `legacy/python/src/qkb/server/mcp.py`.
 *
 * Three tools, mirroring Python's FastMCP server exactly (names, arg names,
 * result shapes):
 *  - `qkb`: hybrid BM25 + vector search (the `query`/`search`/`vsearch`
 *    tiers are collapsed into one MCP tool, same as Python — `rerank` is
 *    accepted but not implemented, matching the Phase 2 stub error).
 *  - `qkb_get`: retrieve a document by id/prefix.
 *  - `qkb_status`: index health (counts, vaults, declared fields).
 *
 * The embedding provider and SQLite connection are built ONCE here and
 * shared by every tool call (mirrors Python's finding-9 fix: no fresh
 * OllamaProvider/httpx.Client or full-DDL SQLite re-open per call). Unlike
 * Python's FastMCP, which forces every tool body to stay a synchronous
 * function so calls can never interleave against the shared conn/provider,
 * this SDK's tool callbacks are async — an `await` inside one call can yield
 * to the event loop before a concurrent call's own `await` resumes, so two
 * tool bodies COULD interleave statements against `conn`/`provider` without
 * an explicit guard. `withLock` below is a tiny promise-chain mutex that
 * serializes every tool body's conn/provider-touching region, restoring the
 * same "one call's DB work completes before the next starts" guarantee
 * Python gets for free from staying synchronous.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { type Config, configuredVaults, loadConfig, vaultPathFor } from "../config.js";
import { connect } from "../db/schema.js";
import { Storage } from "../db/storage.js";
import { getProvider } from "../embed/provider.js";
import type { EmbeddingProvider } from "../embed/types.js";
import { describeRun, startWatch, type Watcher } from "../ingest/watch.js";
import { toPublicMarkers } from "../search/bm25.js";
import { SearchValidationError } from "../search/errors.js";
import { Filters } from "../search/filters.js";
import {
  AmbiguousDocumentPrefixError,
  DocumentDecodeError,
  DocumentFileMissing,
  DocumentNotFoundError,
  getDocument,
} from "../search/retrieval.js";
import { executeSearch } from "../search/service.js";

/** Wraps a JS value as the single-text-content `CallToolResult` shape every
 * tool below returns — the JSON text mirrors Python's `dict` return value
 * (FastMCP serializes a tool's returned dict to a single JSON text content
 * part; this SDK expects the tool body to build that content part itself). */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

type Lock = <T>(fn: () => T | Promise<T>) => Promise<T>;

/** Tiny promise-chain mutex — see module docstring for why the async tool
 * bodies below need this where Python's synchronous ones didn't. */
export function makeLock(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Wrap a provider so its calls run one at a time. The watch loop's
 * `embedPending` and a search's `embedQuery` share one provider in the same
 * process, and a local model context (node-llama-cpp) must not be driven by
 * two calls at once. */
export function serializeProvider(provider: EmbeddingProvider): EmbeddingProvider {
  const lock = makeLock();
  return {
    get dimension() {
      return provider.dimension;
    },
    get modelName() {
      return provider.modelName;
    },
    embed: (texts) => lock(() => provider.embed(texts)),
    embedQuery: (query) => lock(() => provider.embedQuery(query)),
    close: () => provider.close?.(),
  };
}

/** Everything the tools share for the life of the process: config, one
 * SQLite connection, one embedding provider, and the lock serializing tool
 * bodies. The HTTP transport builds a fresh `McpServer` per request (it's
 * stateless) over this same context, so the model is loaded once. */
export interface QkbContext {
  cfg: Config;
  conn: Database.Database;
  provider: EmbeddingProvider;
  withLock: Lock;
  close(): void;
}

export async function createContext(cfg?: Config): Promise<QkbContext> {
  const cfgObj = cfg ?? loadConfig();
  const conn: Database.Database = connect(cfgObj.dbPath, cfgObj.embeddingDim);
  const provider = serializeProvider(await getProvider(cfgObj));
  let closed = false;
  return {
    cfg: cfgObj,
    conn,
    provider,
    withLock: makeLock(),
    close() {
      if (closed) return;
      closed = true;
      provider.close?.();
      conn.close();
    },
  };
}

/** The `qkb` tool's description: what it searches, plus the vault names and
 * declared fields (with their descriptions) so an agent knows what it can
 * filter on without a separate status call. */
function searchToolDescription(cfg: Config): string {
  let d =
    "Search the personal knowledge base (Obsidian vault) with hybrid " +
    "BM25 + vector retrieval. Filter by type, tags, date range, vault, or any " +
    "frontmatter property (`fields: {key: value}`). Each result lists related " +
    "notes (wikilinks in both directions, shared source).";
  const vaults = configuredVaults(cfg);
  if (vaults.length > 1) {
    d += ` Vaults (filter with \`vaults\`): ${vaults.map((v) => v.name).join(", ")}.`;
  }
  const fields = Object.entries(cfg.fields);
  if (fields.length > 0) {
    d +=
      " Notes may carry these extra properties (returned in `fields`, filter with " +
      "`fields: {key: value}`): " +
      fields.map(([k, desc]) => (desc ? `${k} (${desc})` : k)).join("; ") +
      ".";
  }
  return d;
}

/**
 * Register the `qkb`/`qkb_get`/`qkb_status` tools on a new McpServer over
 * `ctx`. Does NOT own `ctx`: closing this server leaves the connection and
 * provider open (the HTTP transport makes one server per request).
 */
export function createMcpServer(ctx: QkbContext): McpServer {
  const { cfg: cfgObj, conn, provider, withLock } = ctx;
  const server = new McpServer({ name: "qkb", version: "0.1.0" });

  server.registerTool(
    "qkb",
    {
      description: searchToolDescription(cfgObj),
      inputSchema: {
        query: z.string(),
        context: z.string().optional(),
        source: z.string().optional(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        vaults: z.array(z.string()).optional(),
        fields: z.record(z.string(), z.string()).optional(),
        limit: z.number().int().optional(),
        rerank: z.boolean().optional(),
      },
    },
    async (args) => {
      if (args.rerank) {
        return jsonResult({ error: "re-ranking not configured (Phase 2)" });
      }
      return withLock(async () => {
        try {
          const results = await executeSearch(
            conn,
            cfgObj,
            provider,
            args.query,
            new Filters({
              context: args.context,
              source: args.source,
              docType: args.type,
              tags: args.tags,
              dateFrom: args.date_from,
              dateTo: args.date_to,
              vaults: args.vaults,
              fields: args.fields,
            }),
            args.limit ?? null,
            "hybrid",
          );
          // `matched_text` may internally carry searchBm25's control-char
          // match markers (issue #14 critical fix — bracket-sniffing broke
          // on markdown checklists/wikilinks; see bm25.ts's module
          // comment). The MCP result is public API (Python parity), so
          // translate back to `[`/`]` here, same as the CLI's `--json`
          // boundary (src/cli/shared.ts's `emit`).
          const publicResults = results.map((r) => ({
            ...r,
            matched_text: r.matched_text !== null ? toPublicMarkers(r.matched_text) : null,
          }));
          return jsonResult({ result: publicResults });
        } catch (e) {
          // Mirrors mcp.py's `except ValueError as e`: executeSearch (and
          // everything it calls — buildFilterClause, hybrid.search) throws
          // SearchValidationError for every expected validation failure
          // (bad limit, empty/whitespace filter values, unparseable dates,
          // ingest-in-progress, dimension mismatch). Anything else (a real
          // bug, a SQLite error) is NOT a validation failure and must
          // propagate uncaught, same as Python — packaging it into
          // `{"error": ...}` here would silently mask it instead.
          if (e instanceof SearchValidationError) {
            return jsonResult({ error: e.message });
          }
          throw e;
        }
      });
    },
  );

  server.registerTool(
    "qkb_get",
    {
      description:
        "Retrieve a document by id (full or prefix): metadata, every frontmatter " +
        "property, file path, obsidian:// URI, related notes, and optionally the raw " +
        "markdown body.",
      inputSchema: {
        document_id: z.string(),
        include_raw: z.boolean().optional(),
        include_related: z.boolean().optional(),
      },
    },
    async (args) => {
      return withLock(() => {
        try {
          const doc = getDocument(
            conn,
            args.document_id,
            (name) => vaultPathFor(cfgObj, name),
            args.include_raw ?? false,
            args.include_related ?? true,
          );
          return jsonResult(doc);
        } catch (e) {
          // Mirrors mcp.py's `except (DocumentFileMissing, KeyError, ValueError)`:
          // DocumentNotFoundError~KeyError, AmbiguousDocumentPrefixError~ValueError,
          // DocumentFileMissing as-is, and DocumentDecodeError (TS-only — restores
          // fail-loud UTF-8 decode behavior; Python's UnicodeDecodeError IS a
          // ValueError subclass, so it's caught here too, same as Python).
          if (
            e instanceof DocumentNotFoundError ||
            e instanceof AmbiguousDocumentPrefixError ||
            e instanceof DocumentFileMissing ||
            e instanceof DocumentDecodeError
          ) {
            return jsonResult({ error: e.message });
          }
          throw e;
        }
      });
    },
  );

  server.registerTool(
    "qkb_status",
    {
      description:
        "Index health: document/chunk counts, vaults, declared frontmatter " +
        "fields with their descriptions and most common values, last ingestion time.",
    },
    async () => {
      return withLock(() => {
        const storage = new Storage(conn);
        const stats = storage.stats();
        const counts = new Map(storage.vaultCounts().map((c) => [c.vault, c.documents]));
        // Storage.stats() returns TS-camelCase (`lastIndexedAt`) — remapped
        // to Python's snake_case dict keys here so the tool's JSON result
        // matches mcp.py's `Storage(conn).stats()` byte-for-byte (plus the
        // multi-vault / declared-fields additions).
        return jsonResult({
          documents: stats.documents,
          chunks: stats.chunks,
          vectors: stats.vectors,
          dim: stats.dim,
          last_indexed_at: stats.lastIndexedAt,
          vaults: configuredVaults(cfgObj).map((v) => ({
            name: v.name,
            documents: counts.get(v.name) ?? 0,
          })),
          fields: cfgObj.fields,
          // What each declared field holds, for building `fields` filters.
          field_values: storage.fieldSummary(cfgObj.fields),
        });
      });
    },
  );

  return server;
}

/**
 * Build a self-contained qkb MCP server (the stdio shape): a fresh context
 * plus the tools over it. Ported from `mcp.py`'s `build_server`.
 *
 * The provider is resolved via `getProvider` (async — e.g. the `llama`
 * provider's constructor is lazy and does no model loading here; loading
 * happens on first `embed`/`embedQuery` call), so bm25-only tool calls never
 * pay any provider startup cost.
 *
 * Closing: assigns `server.server.onclose` to release the provider (if it
 * exposes `close()`) and the SQLite connection. This fires whenever the
 * underlying transport disconnects (mirrors Python's `lifespan` teardown,
 * which Python drives via an `asynccontextmanager` FastMCP has no TS
 * equivalent for — `Protocol#onclose` is the closest hook this SDK exposes).
 */
export async function buildServer(cfg?: Config): Promise<McpServer> {
  const ctx = await createContext(cfg);
  const server = createMcpServer(ctx);
  server.server.onclose = () => ctx.close();
  return server;
}

export interface ServeOptions {
  /** Re-index on a timer while serving. */
  watch?: boolean;
  /** Seconds between re-index runs (default: config `watch.interval`). */
  interval?: number;
}

/** Start the watch loop for a serving process. It writes through its OWN
 * connection (WAL lets it commit while the server's connection reads) but
 * shares the server's (serialized) provider, so the model loads once. Logs go
 * to stderr: on stdio, stdout is the MCP channel. */
export function startServerWatch(ctx: QkbContext, intervalSec: number): Watcher {
  const writeConn = connect(ctx.cfg.dbPath, ctx.cfg.embeddingDim);
  const watcher = startWatch(writeConn, ctx.cfg, ctx.provider, {
    intervalSec,
    onRun: (r) => {
      const line = describeRun(r);
      if (line) console.error(`qkb: ${line}`);
    },
    onError: (e) => {
      console.error(`qkb: re-index failed: ${e instanceof Error ? e.message : String(e)}`);
    },
  });
  return {
    runNow: () => watcher.runNow(),
    async stop() {
      await watcher.stop();
      writeConn.close();
    },
  };
}

/** Real entry point: build the server and serve it over stdio until the
 * transport closes. Ported from `mcp.py`'s `run_server`. */
export async function runServer(opts: ServeOptions = {}): Promise<void> {
  const ctx = await createContext();
  const server = createMcpServer(ctx);
  const watcher = opts.watch ? startServerWatch(ctx, opts.interval ?? ctx.cfg.watchInterval) : null;
  server.server.onclose = () => {
    void (async () => {
      await watcher?.stop();
      ctx.close();
    })();
  };
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpServeOptions extends ServeOptions {
  host?: string;
  port?: number;
}

/** `qkb mcp --http`: serve Streamable HTTP until SIGINT/SIGTERM, then stop
 * the watch loop and close the listener, connection and provider. */
export async function runHttpServer(opts: HttpServeOptions = {}): Promise<void> {
  const { startHttpServer } = await import("./http.js");
  const ctx = await createContext();
  const http = await startHttpServer(ctx, {
    host: opts.host ?? ctx.cfg.mcpHost,
    port: opts.port ?? ctx.cfg.mcpPort,
    allowedOrigins: ctx.cfg.mcpAllowedOrigins,
  });
  const watcher = opts.watch ? startServerWatch(ctx, opts.interval ?? ctx.cfg.watchInterval) : null;
  console.error(`qkb: MCP server listening on ${http.url}/mcp`);

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  await http.close();
  await watcher?.stop();
  ctx.close();
}
