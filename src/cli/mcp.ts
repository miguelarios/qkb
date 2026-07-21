/** `mcp` command. Ports `mcp` from `legacy/python/src/qkb/cli.py`.
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
import { action } from "./shared.js";

async function runMcp(): Promise<void> {
  const mod = await import("../server/mcp.js");
  await mod.runServer();
}

export function registerMcpCommand(program: Command): void {
  program.command("mcp").description("Run the MCP stdio server").action(action(runMcp));
}
