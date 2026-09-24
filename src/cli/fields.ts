/** `fields` command: the declared frontmatter fields (`[frontmatter.fields]`),
 * their descriptions, and how they are used across the index (#35). Replaces
 * `contexts` / `context describe`: `context` is now an ordinary field, and a
 * field's description lives in the config. */
import type { Command } from "commander";
import { Storage } from "../db/storage.js";
import { action, cfg, failUsage, openDb } from "./shared.js";

async function runFields(opts: { json?: boolean }): Promise<void> {
  const cfgObj = cfg();
  const rows = new Storage(openDb(cfgObj)).fieldSummary(cfgObj.fields, 5, cfgObj.siblingFields);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No fields declared. Add them to your config, e.g.:");
    console.log('  [frontmatter.fields]\n  project = "Project this note belongs to"');
    return;
  }
  for (const r of rows) {
    const sib = r.siblings ? ", siblings" : "";
    console.log(
      `${r.field}  (${r.documents} notes${sib})${r.description ? `  ${r.description}` : ""}`,
    );
    if (r.top_values.length > 0) {
      console.log(`  ${r.top_values.map((v) => `${v.value} (${v.count})`).join(", ")}`);
    }
  }
}

export function registerFieldsCommands(program: Command): void {
  program
    .command("fields")
    .description("List declared frontmatter fields, their descriptions and top values")
    .option("--json", "machine-readable output")
    .action(action(runFields));

  // Kept one release so scripts get a pointer instead of "unknown command".
  program
    .command("contexts", { hidden: true })
    .option("--json", "machine-readable output")
    .action(
      action(async (opts: { json?: boolean }) => {
        console.error("note: `qkb contexts` is now `qkb fields` (declare `context` as a field)");
        await runFields(opts);
      }),
    );
  program
    .command("context", { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(
      action(async () => {
        failUsage(
          "`qkb context describe` was removed: declare the field with a description in your " +
            'config instead, e.g. [frontmatter.fields] context = "Area of my life a note belongs to"',
        );
      }),
    );
}
