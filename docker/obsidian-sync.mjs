#!/usr/bin/env node
// Optional Obsidian Sync sidecar (`obsidian-sync` service in the compose
// example). Keeps the vaults under /vaults in sync with Obsidian Sync using
// Obsidian's own headless client, `obsidian-headless` (the `ob` command).
//
// The client is proprietary and not part of this image: it is installed from
// npm into the state volume on first start. Its login and per-vault sync
// state live in the same volume (HOME is /data).
//
//   obsidian-sync                  run `ob sync --continuous` for every vault
//                                  set up with `ob sync-setup`
//   obsidian-sync ob <args...>     run the client, e.g. `ob login`
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = join(process.env.HOME || "/data", "obsidian-headless");
const WANTED = process.env.OBSIDIAN_HEADLESS_VERSION || "latest";
const OB = join(PREFIX, "node_modules", ".bin", "ob");
const log = (m) => console.error(`obsidian-sync: ${m}`);

function installedVersion() {
  try {
    const pkg = join(PREFIX, "node_modules", "obsidian-headless", "package.json");
    return JSON.parse(readFileSync(pkg, "utf-8")).version;
  } catch {
    return null;
  }
}

/** Install the client when it is missing, or when a pinned version differs. */
function ensureClient() {
  const have = installedVersion();
  if (have && existsSync(OB) && (WANTED === "latest" || WANTED === have)) return;
  log(`installing obsidian-headless@${WANTED} from npm into ${PREFIX}`);
  const r = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--prefix", PREFIX, `obsidian-headless@${WANTED}`],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (r.status !== 0) {
    log("could not install obsidian-headless (is registry.npmjs.org reachable?)");
    process.exit(1);
  }
  log(`installed obsidian-headless ${installedVersion()}`);
}

/** Local folders set up with `ob sync-setup`. */
function configuredVaults() {
  const r = spawnSync(OB, ["sync-list-local", "--json"], { encoding: "utf-8" });
  try {
    return JSON.parse(r.stdout).vaults.map((v) => v.path);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  ensureClient();

  if (args[0] === "ob") {
    const r = spawnSync(OB, args.slice(1), { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  let stopping = false;
  const children = [];
  const stop = () => {
    stopping = true;
    for (const c of children) c.kill("SIGTERM");
    if (children.length === 0) process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  let vaults = configuredVaults();
  if (vaults.length === 0) {
    log("no vault is set up yet. Run, once:");
    log("  docker compose run --rm obsidian-sync ob login");
    log("  docker compose run --rm obsidian-sync ob sync-list-remote");
    log('  docker compose run --rm obsidian-sync ob sync-setup --vault "<remote vault>" --path /vaults/<Name>');
    log("waiting; sync starts by itself once a vault is set up");
    while (vaults.length === 0) {
      await sleep(15_000);
      if (stopping) return;
      vaults = configuredVaults();
    }
  }

  for (const path of vaults) {
    log(`syncing ${path}`);
    const child = spawn(OB, ["sync", "--continuous", "--path", path], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    children.push(child);
    child.on("exit", (code, signal) => {
      children.splice(children.indexOf(child), 1);
      if (!stopping) {
        // One sync ended (network loss, login expired, vault unlinked): stop
        // the rest and exit non-zero so the restart policy starts over.
        log(`sync of ${path} stopped (${signal ?? `exit ${code}`})`);
        stopping = true;
        process.exitCode = 1;
        for (const c of children) c.kill("SIGTERM");
      }
      if (children.length === 0) process.exit(process.exitCode ?? 0);
    });
  }
}

main();
