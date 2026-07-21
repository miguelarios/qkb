/** MCP stdio server entry point — SEAM STUB, not yet implemented.
 *
 * This is the lazy-import seam `src/cli/mcp.ts`'s `qkb mcp` command calls
 * into (Task 15, the CLI task). The real server (porting
 * `legacy/python/src/qkb/server/mcp.py`'s `build_server`/`run_server`) lands
 * in Task 16 — that task should REPLACE this file's contents wholesale
 * (keeping the `runServer` export, since `cli/mcp.ts` calls it) rather than
 * edit around this stub.
 *
 * `cli/mcp.ts` imports this module lazily (`await import(...)` inside the
 * command action, not a static top-level import), so nothing outside `qkb
 * mcp` pays any cost for this module existing/changing.
 */
export async function runServer(): Promise<void> {
  throw new Error("qkb mcp: not implemented yet (coming in a later task)");
}
