/** `mcp` and `watch` commands. Ports `mcp` from `legacy/python/src/qkb/cli.py`
 * and adds the Streamable HTTP transport and watch mode.
 *
 * `src/server/mcp.ts` is the real MCP server (`build_server`/`run_server`
 * ported from `legacy/python/src/qkb/server/mcp.py`). This imports it
 * lazily — `await import(...)` inside the action, not a static top-level
 * import — so nothing outside `qkb mcp` pays any cost for that module
 * (and its `@modelcontextprotocol/sdk`/embedding-provider dependencies)
 * existing/loading. Any startup error it throws (e.g. a malformed config)
 * still gets the `action()` wrapper's clean one-line error (no stack trace),
 * same as any other command failure. */
import type { Command } from "commander";
import { action, failUsage } from "./shared.js";

interface McpOpts {
  http?: boolean;
  host?: string;
  port?: string;
  watch?: boolean;
  interval?: string;
}

function positiveNumber(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) failUsage(`${flag} must be a positive number, got ${raw}`);
  return n;
}

function portNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // 0 = any free port (the bound URL is printed on startup).
  if (!Number.isInteger(n) || n < 0 || n > 65535) failUsage(`--port must be 0-65535, got ${raw}`);
  return n;
}

async function runMcp(opts: McpOpts): Promise<void> {
  const port = portNumber(opts.port);
  const interval = positiveNumber("--interval", opts.interval);
  if (!opts.http && (opts.host !== undefined || port !== undefined)) {
    failUsage("--host/--port need --http");
  }
  const mod = await import("../server/mcp.js");
  if (opts.http) {
    await mod.runHttpServer({ host: opts.host, port, watch: opts.watch, interval });
  } else {
    await mod.runServer({ watch: opts.watch, interval });
  }
}

async function runWatch(opts: { interval?: string }): Promise<void> {
  const interval = positiveNumber("--interval", opts.interval);
  const [{ loadConfig }, { connect }, { getProvider }, watch] = await Promise.all([
    import("../config.js"),
    import("../db/schema.js"),
    import("../embed/provider.js"),
    import("../ingest/watch.js"),
  ]);
  const cfgObj = loadConfig();
  const conn = connect(cfgObj.dbPath, cfgObj.embeddingDim);
  const provider = await getProvider(cfgObj);
  const intervalSec = interval ?? cfgObj.watchInterval;
  console.log(`Watching (re-index every ${intervalSec}s) — Ctrl-C to stop`);
  const watcher = watch.startWatch(conn, cfgObj, provider, {
    intervalSec,
    onRun: (r) => {
      const line = watch.describeRun(r);
      if (line) console.log(`${new Date().toISOString()}  ${line}`);
    },
    onError: (e) => {
      console.error(`re-index failed: ${e instanceof Error ? e.message : String(e)}`);
    },
  });
  // The watcher's timer is unref'd, so hold the process open until a signal.
  const keepAlive = setInterval(() => {}, 1 << 30);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  clearInterval(keepAlive);
  await watcher.stop();
  provider.close?.();
  conn.close();
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Run the MCP server (stdio by default, --http for Streamable HTTP)")
    .option("--http", "serve Streamable HTTP at /mcp instead of stdio")
    .option("--host <host>", "HTTP bind address (default 127.0.0.1; 0.0.0.0 in containers)")
    .option("--port <port>", "HTTP port (default 8181)")
    .option("--watch", "re-index the vault(s) on a timer while serving")
    .option("--interval <seconds>", "seconds between re-index runs (default 300)")
    .action(action(runMcp));

  program
    .command("watch")
    .description("Re-run ingest + embed on a timer until stopped")
    .option("--interval <seconds>", "seconds between re-index runs (default 300)")
    .action(action(runWatch));
}
