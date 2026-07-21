/** MCP stdio server exposing qkb search to LLM agents (DESIGN.md §9.2).
 * Ported from `legacy/python/src/qkb/server/mcp.py`.
 *
 * Three tools, mirroring Python's FastMCP server exactly (names, arg names,
 * result shapes):
 *  - `qkb`: hybrid BM25 + vector search (the `query`/`search`/`vsearch`
 *    tiers are collapsed into one MCP tool, same as Python — `rerank` is
 *    accepted but not implemented, matching the Phase 2 stub error).
 *  - `qkb_get`: retrieve a document by id/prefix.
 *  - `qkb_status`: index health (document/chunk/vector counts, contexts).
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
import { type Config, loadConfig } from "../config.js";
import { connect } from "../db/schema.js";
import { Storage } from "../db/storage.js";
import { getProvider } from "../embed/provider.js";
import type { EmbeddingProvider } from "../embed/types.js";
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

/** Tiny promise-chain mutex — see module docstring for why the async tool
 * bodies below need this where Python's synchronous ones didn't. */
function makeLock(): <T>(fn: () => T | Promise<T>) => Promise<T> {
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

/**
 * Build the qkb MCP server: registers the `qkb`/`qkb_get`/`qkb_status`
 * tools against a single shared SQLite connection and embedding provider.
 * Ported from `mcp.py`'s `build_server`.
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
  const cfgObj = cfg ?? loadConfig();
  const conn: Database.Database = connect(cfgObj.dbPath, cfgObj.embeddingDim);
  const provider: EmbeddingProvider = await getProvider(cfgObj);
  const withLock = makeLock();

  const server = new McpServer({ name: "qkb", version: "0.1.0" });

  server.server.onclose = () => {
    provider.close?.();
    conn.close();
  };

  server.registerTool(
    "qkb",
    {
      description:
        "Search the personal knowledge base (Obsidian vault) with hybrid " +
        "BM25 + vector retrieval. Filter by context, source, type, tags, or " +
        "date range. Results include sibling documents and context " +
        "descriptions.",
      inputSchema: {
        query: z.string(),
        context: z.string().optional(),
        source: z.string().optional(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
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
            }),
            args.limit ?? null,
            "hybrid",
          );
          return jsonResult({ result: results });
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
        "Retrieve a document by UUID (full or prefix): metadata, file path, " +
        "obsidian:// URI, siblings, and optionally the raw markdown body.",
      inputSchema: {
        document_id: z.string(),
        include_raw: z.boolean().optional(),
        include_siblings: z.boolean().optional(),
      },
    },
    async (args) => {
      return withLock(() => {
        try {
          const doc = getDocument(
            conn,
            args.document_id,
            cfgObj.vaultPath,
            args.include_raw ?? false,
            args.include_siblings ?? true,
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
        "Index health: document/chunk counts, context list with " +
        "descriptions, last ingestion time.",
    },
    async () => {
      return withLock(() => {
        const stats = new Storage(conn).stats();
        // Storage.stats() returns TS-camelCase (`lastIndexedAt`) — remapped
        // to Python's snake_case dict keys here so the tool's JSON result
        // matches mcp.py's `Storage(conn).stats()` byte-for-byte.
        return jsonResult({
          documents: stats.documents,
          chunks: stats.chunks,
          vectors: stats.vectors,
          dim: stats.dim,
          contexts: stats.contexts,
          last_indexed_at: stats.lastIndexedAt,
        });
      });
    },
  );

  return server;
}

/** Real entry point: build the server and serve it over stdio until the
 * transport closes. Ported from `mcp.py`'s `run_server`. */
export async function runServer(): Promise<void> {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
