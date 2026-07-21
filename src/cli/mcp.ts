/** `mcp` command. Ports `mcp` from `legacy/python/src/qkb/cli.py`.
 *
 * `src/server/mcp.ts` is a seam stub today (Task 16 replaces it with the
 * real MCP server). This imports it lazily — `await import(...)` inside the
 * action, not a static top-level import — so once Task 16 drops the real
 * module in, `qkb mcp` starts working with no change to this file, and
 * nothing outside `qkb mcp` pays any cost for that module existing/loading.
 * The stub's own `runServer()` throws a clear "not implemented yet"
 * message, which the `action()` wrapper below turns into a clean one-line
 * error (no stack trace) same as any other command failure. */
import type { Command } from "commander";
import { action } from "./shared.js";

async function runMcp(): Promise<void> {
  const mod = await import("../server/mcp.js");
  await mod.runServer();
}

export function registerMcpCommand(program: Command): void {
  program.command("mcp").description("Run the MCP stdio server").action(action(runMcp));
}
