/** `get` command. Ports `get` from `legacy/python/src/qkb/cli.py`.
 *
 * Note the `--json` flag Python's `get` used to have was removed (see
 * test_cli.py's `test_get_rejects_removed_json_flag_but_status_accepts_it`)
 * — `get` always emits JSON now. commander's default "unknown option"
 * message is rewritten to read "no such option" at the top level (see
 * `../cli.ts`) so this stays parity with Click's wording. */
import type { Command } from "commander";
import {
  AmbiguousDocumentPrefixError,
  DocumentDecodeError,
  DocumentFileMissing,
  DocumentNotFoundError,
  getDocument,
} from "../search/retrieval.js";
import { action, cfg, openDb, openInBrowser } from "./shared.js";

async function runGet(idOrPrefix: string, opts: { raw?: boolean; open?: boolean }): Promise<void> {
  const cfgObj = cfg();
  const conn = openDb(cfgObj);
  let doc: ReturnType<typeof getDocument>;
  try {
    doc = getDocument(conn, idOrPrefix, cfgObj.vaultPath, Boolean(opts.raw));
  } catch (e) {
    // Ports cli.py's `except (DocumentFileMissing, KeyError, ValueError)` —
    // click.echo(str(e), err=True); sys.exit(1) (no "Error:" prefix). The TS
    // equivalents are DocumentNotFoundError (KeyError), AmbiguousDocument-
    // PrefixError (ValueError), DocumentFileMissing, and (TS-only, restoring
    // fail-loud UTF-8 decode behavior — see retrieval.ts) DocumentDecodeError.
    if (
      e instanceof DocumentNotFoundError ||
      e instanceof AmbiguousDocumentPrefixError ||
      e instanceof DocumentFileMissing ||
      e instanceof DocumentDecodeError
    ) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (opts.open) {
    openInBrowser(doc.obsidian_uri);
  }
  console.log(JSON.stringify(doc, null, 2));
}

export function registerGetCommand(program: Command): void {
  program
    .command("get")
    .argument("<id_or_prefix>")
    .option("--raw", "include the note's raw markdown text")
    .option("--open", "open in Obsidian")
    .action(action(runGet));
}
