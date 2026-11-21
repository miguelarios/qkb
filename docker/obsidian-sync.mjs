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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = join(process.env.HOME || "/data", "obsidian-headless");
const WANTED = process.env.OBSIDIAN_HEADLESS_VERSION || "latest";
const OB = join(PREFIX, "node_modules", ".bin", "ob");
// Written only after a complete install, so an interrupted one is redone.
const MARKER = join(PREFIX, ".installed");
/** How often to look for vaults set up since the last look. */
const POLL_MS = 30_000;
/** A sync that stops sooner than this failed for a reason a restart will not
 * fix (subscription ended, vault removed, logged out). */
const QUICK_EXIT_MS = 60_000;
// OBSYNC_PAUSE_MS shortens the pause, for testing.
const QUICK_EXIT_PAUSE_MS = Number(process.env.OBSYNC_PAUSE_MS ?? 5 * 60_000);

const log = (m) => console.error(`obsidian-sync: ${m}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;
/** A sync stopped by itself: winding down to exit non-zero. */
let failing = false;
/** Running child processes; a stop signal is passed on to each. */
const children = new Set();

function onSignal(signal) {
  stopping = true;
  for (const c of children) c.kill(signal);
  // Nothing running (waiting for setup, or pausing): leave now.
  if (children.size === 0 || failing) process.exit(failing ? 1 : 0);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

/** Run a command to completion. Resolves with its exit code and, when
 * `capture` is set, its stdout. Never rejects. */
function run(cmd, args, { capture = false, interactive = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: [interactive ? "inherit" : "ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    children.add(child);
    const done = (code) => {
      children.delete(child);
      resolve({ code, out });
    };
    child.on("error", (e) => {
      log(`could not run ${cmd}: ${e.message}`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

/** Install the client unless this exact request was already installed. */
async function ensureClient() {
  let installed = null;
  try {
    installed = JSON.parse(readFileSync(MARKER, "utf-8"));
  } catch {
    // not installed, or an install was interrupted
  }
  if (installed?.wanted === WANTED && existsSync(OB)) return;
  log(`installing obsidian-headless@${WANTED} from npm into ${PREFIX}`);
  rmSync(MARKER, { force: true });
  const { code } = await run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--prefix",
    PREFIX,
    `obsidian-headless@${WANTED}`,
  ]);
  if (stopping) process.exit(0);
  if (code !== 0) {
    log("could not install obsidian-headless (it needs registry.npmjs.org and github.com)");
    process.exit(1);
  }
  const pkg = join(PREFIX, "node_modules", "obsidian-headless", "package.json");
  const version = JSON.parse(readFileSync(pkg, "utf-8")).version;
  writeFileSync(MARKER, JSON.stringify({ wanted: WANTED, version }));
  log(`installed obsidian-headless ${version}`);
}

/** Local folders set up with `ob sync-setup`; null when the client fails. */
async function configuredVaults() {
  const { code, out } = await run(OB, ["sync-list-local", "--json"], { capture: true });
  try {
    if (code === 0) return JSON.parse(out).vaults.map((v) => v.path);
  } catch {
    // fall through
  }
  return null;
}

/** Pause, then exit non-zero so the restart policy starts over. */
async function restartLater(pauseMs) {
  for (const c of children) c.kill("SIGTERM");
  if (pauseMs > 0) {
    log(`not retrying for ${Math.round(pauseMs / 60_000)} minutes; fix the cause above, then`);
    log("  docker compose restart obsidian-sync");
    await sleep(pauseMs);
  }
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  await ensureClient();

  if (args[0] === "ob") {
    const { code } = await run(OB, args.slice(1), { interactive: true });
    process.exit(code);
  }

  const syncing = new Set();
  let told = false;
  while (!stopping) {
    const vaults = await configuredVaults();
    if (stopping) break;
    if (vaults === null) {
      log("the client failed to list its vaults (output above)");
      await restartLater(QUICK_EXIT_PAUSE_MS);
    } else if (vaults.length === 0 && !told) {
      told = true;
      log("no vault is set up yet. Run, once:");
      log("  docker compose run --rm obsidian-sync ob login");
      log("  docker compose run --rm obsidian-sync ob sync-list-remote");
      log('  docker compose run --rm obsidian-sync ob sync-setup --vault "<remote vault>" --path /vaults/<Name>');
      log("waiting; sync starts by itself once a vault is set up");
    }
    for (const path of vaults ?? []) {
      if (syncing.has(path)) continue;
      syncing.add(path);
      log(`syncing ${path}`);
      const started = Date.now();
      run(OB, ["sync", "--continuous", "--path", path]).then(({ code }) => {
        if (failing) return; // restartLater() owns the exit
        if (stopping) {
          if (children.size === 0) process.exit(0);
          return;
        }
        stopping = true;
        failing = true;
        log(`sync of ${path} stopped (exit ${code})`);
        restartLater(Date.now() - started < QUICK_EXIT_MS ? QUICK_EXIT_PAUSE_MS : 0);
      });
    }
    await sleep(POLL_MS);
  }
}

main();
