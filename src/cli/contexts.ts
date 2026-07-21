/** `contexts` and `context describe` commands. Ports `contexts`/`context`/
 * `describe` from `legacy/python/src/qkb/cli.py`. */
import type { Command } from "commander";
import { Storage } from "../db/storage.js";
import { normalizeContext } from "../ingest/parser.js";
import { action, cfg, failUsage, openDb } from "./shared.js";

async function runContexts(opts: { json?: boolean }): Promise<void> {
  const rows = new Storage(openDb(cfg())).listContexts();
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    console.log(`${r.context}  (${r.count})  ${r.description ?? ""}`);
  }
}

async function runContextDescribe(
  label: string,
  description: string | undefined,
  opts: { remove?: boolean },
): Promise<void> {
  const context = normalizeContext(label);
  if (context === null) {
    failUsage("label must not be empty");
  }
  const storage = new Storage(openDb(cfg()));
  if (opts.remove) {
    storage.setContextDescription(context, null);
  } else if (description) {
    storage.setContextDescription(context, description);
  } else {
    failUsage("provide a description or --remove");
  }
}

export function registerContextsCommands(program: Command): void {
  program
    .command("contexts")
    .option("--json", "machine-readable output")
    .action(action(runContexts));

  const context = program.command("context").description("Manage context descriptions");

  context
    .command("describe")
    .argument("<label>")
    .argument("[description]")
    .option("--remove", "remove the description")
    .action(action(runContextDescribe));
}
