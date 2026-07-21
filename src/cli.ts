#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { registerContextsCommands } from "./cli/contexts.js";
import { registerGetCommand } from "./cli/get.js";
import { registerIngestCommands } from "./cli/ingest.js";
import { registerMcpCommand } from "./cli/mcp.js";
import { registerSearchCommands } from "./cli/search.js";
import { registerStatusCommand } from "./cli/status.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Reads the package version from package.json, which sits one level up
 * from this file both as compiled (`dist/cli.js`) and as source
 * (`src/cli.ts` run directly). */
export function readVersion(): string {
  const packageJsonPath = join(here, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version: string;
  };
  return packageJson.version;
}

/** Builds the full `qkb` command tree: `ingest`, `embed`, `search`,
 * `vsearch`, `query`, `get`, `contexts`, `context describe`, `status`,
 * `mcp` — ports the command surface of `legacy/python/src/qkb/cli.py`.
 * Individual command implementations live in `./cli/*.ts`; this function
 * only assembles them, mirroring cli.py's `@cli.group()`/`@cli.command()`
 * wiring.
 *
 * `exitOverride()` (throw a `CommanderError` instead of calling
 * `process.exit()` for commander's OWN parsing errors — unknown
 * command/option, missing required argument, `--help`/`--version`) and the
 * `configureOutput()` error-message rewrite below MUST be installed before
 * any `registerXCommands()` call: commander subcommands snapshot their
 * parent's `_exitCallback`/`_outputConfiguration` at the moment they're
 * created (`copyInheritedSettings`, `commander/lib/command.js`), not
 * dynamically at error time — setting these on `program` afterward would
 * silently not apply to any subcommand already added (verified: an
 * unrecognized option on a subcommand fell through to a raw
 * `process.exit()` and the un-rewritten "unknown option" wording when this
 * was ordered the other way around). */
export function createProgram(): Command {
  const program = new Command();
  program
    .name("qkb")
    .description("qkb — hybrid search for Obsidian vaults")
    .version(readVersion(), "--version", "print the qkb version");
  program.exitOverride();
  program.configureOutput({
    outputError: (str, write) => {
      // Click's error for an unrecognized option reads "no such option:
      // --foo"; commander's reads "unknown option '--foo'". `get --json`
      // relies on this literal wording (test_cli.py's
      // test_get_rejects_removed_json_flag_but_status_accepts_it) — rewrite
      // commander's message to match rather than diverge on phrasing alone.
      write(str.replace("unknown option", "no such option"));
    },
  });

  registerIngestCommands(program);
  registerSearchCommands(program);
  registerGetCommand(program);
  registerContextsCommands(program);
  registerStatusCommand(program);
  registerMcpCommand(program);

  return program;
}

/** Runs the real CLI entry point: builds the command tree (which already
 * has clean error handling installed — see `createProgram()`) and parses
 * `process.argv`.
 *
 * Errors thrown by command *actions* are handled by each command's own
 * `action()` wrapper (`./cli/shared.ts`) and never reach here as a
 * rejection — but if one somehow did, letting it propagate (rather than
 * swallowing it) is the correct failure mode: a stack trace here means a
 * real bug in this wiring, not a user-facing error path that regressed to
 * being unclean. */
export async function main(argv: string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    throw err;
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main(process.argv);
}
