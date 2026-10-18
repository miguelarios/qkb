/** Finds a `better-sqlite3` native addon that the running Node can load.
 *
 * `better-sqlite3` is compiled against V8's ABI (`NODE_MODULE_VERSION`), not
 * N-API, so the binary `npm install` put in `build/Release/` only loads under
 * the Node major that installed it. An MCP client that launches `qkb` with its
 * own bundled Node — or the user upgrading Node — therefore broke startup with
 * a raw dlopen error (#41, #42). The same failure shows up as "Could not
 * locate the bindings file" when npm skipped the install script entirely.
 *
 * On either failure, this falls back to a binary for the running Node's ABI
 * kept in qkb's cache (`~/.cache/qkb/native/...`), downloading the upstream
 * prebuilt (via `prebuild-install`, which `better-sqlite3` already depends
 * on) the first time a given ABI is seen. If that cannot work — offline, or a
 * Node with no upstream prebuild — it throws a `NativeAddonError` naming both
 * Node versions and the fix, instead of the loader's message.
 *
 * `node-llama-cpp` (N-API) and `sqlite-vec` (a SQLite extension) are not
 * affected and need none of this. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export class NativeAddonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeAddonError";
  }
}

/** `NODE_MODULE_VERSION` → Node major, for messages only. */
const ABI_TO_NODE: Record<string, string> = {
  "108": "18",
  "115": "20",
  "120": "21",
  "127": "22",
  "131": "23",
  "137": "24",
  "141": "25",
  "147": "26",
};

export function nodeMajorForAbi(abi: string): string | undefined {
  return ABI_TO_NODE[abi];
}

/** True for the two ways a missing/mismatched addon surfaces: Node's dlopen
 * failure, or the `bindings` package finding no binary at all. */
export function isAddonLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as Error & { code?: string }).code;
  return code === "ERR_DLOPEN_FAILED" || e.message.includes("Could not locate the bindings file");
}

/** The ABI the installed addon was built for — the first
 * `NODE_MODULE_VERSION n` in Node's mismatch message. */
export function addonAbiFromError(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  return /NODE_MODULE_VERSION (\d+)/.exec(e.message)?.[1];
}

export function nativeCacheDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  if (env.QKB_NATIVE_CACHE_DIR) return env.QKB_NATIVE_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "qkb", "native");
  return join(home, ".cache", "qkb", "native");
}

/** Everything `resolveNativeBinding` touches outside its own logic, so tests
 * can drive every branch without a second Node or the network. */
export interface NativeDeps {
  env: NodeJS.ProcessEnv;
  abi: string;
  nodeVersion: string;
  execPath: string;
  platform: string;
  arch: string;
  addonVersion: string;
  /** The installed `better-sqlite3` package directory. */
  addonDir: string;
  /** The installed qkb package directory. */
  qkbDir: string;
  /** Loads the addon npm installed; throws as better-sqlite3 would. */
  loadDefault(): void;
  /** Loads the addon at `path`; throws if it cannot. */
  loadFrom(path: string): void;
  /** Puts the prebuilt addon for this Node at `<dest>/build/Release/`. */
  fetchPrebuilt(dest: string): void;
}

const ADDON_FILE = join("build", "Release", "better_sqlite3.node");

/** Returns `undefined` when the installed addon loads (the normal case), or
 * the path of a compatible binary to pass as better-sqlite3's
 * `nativeBinding`. Throws `NativeAddonError` when there is none. */
export function resolveNativeBinding(deps: NativeDeps = defaultDeps()): string | undefined {
  let loadError: unknown;
  try {
    deps.loadDefault();
    return undefined;
  } catch (e) {
    if (!isAddonLoadError(e)) throw e;
    loadError = e;
  }

  const dir = join(
    nativeCacheDir(deps.env),
    `better-sqlite3-${deps.addonVersion}`,
    `node-v${deps.abi}-${deps.platform}-${deps.arch}`,
  );
  const cached = join(dir, ADDON_FILE);

  let fetchFailure: string;
  if (existsSync(cached)) {
    try {
      deps.loadFrom(cached);
      return cached;
    } catch (e) {
      // A corrupt or stale cache entry: drop it and fetch again below.
      rmSync(dir, { recursive: true, force: true });
      fetchFailure = `cached addon at ${cached} did not load: ${message(e)}`;
    }
  }

  if (deps.env.QKB_NATIVE_DOWNLOAD === "0") {
    fetchFailure = "download disabled (QKB_NATIVE_DOWNLOAD=0)";
  } else {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      // Fetch into a private directory and rename it into place, so two qkb
      // processes starting at once never load a half-extracted file.
      const staging = mkdtempSync(`${dir}.tmp-`);
      try {
        deps.fetchPrebuilt(staging);
        if (!existsSync(join(staging, ADDON_FILE))) {
          throw new Error("prebuild-install finished but produced no addon");
        }
        try {
          renameSync(staging, dir);
        } catch (e) {
          // Another process won the race; its copy is just as good.
          if (!existsSync(cached)) throw e;
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      deps.loadFrom(cached);
      return cached;
    } catch (e) {
      fetchFailure = message(e);
    }
  }

  throw new NativeAddonError(explain(deps, loadError, fetchFailure));
}

function explain(deps: NativeDeps, loadError: unknown, fetchFailure: string): string {
  const builtAbi = addonAbiFromError(loadError);
  const runningMajor = deps.nodeVersion.split(".")[0];
  const installed = builtAbi
    ? `built for NODE_MODULE_VERSION ${builtAbi}${nodeMajorForAbi(builtAbi) ? ` (Node ${nodeMajorForAbi(builtAbi)})` : ""}`
    : "missing (npm may have skipped its install script)";
  const lines = [
    "qkb's SQLite addon (better-sqlite3) does not match this Node.js, and no matching build could be fetched.",
    `  running:   Node v${deps.nodeVersion} (NODE_MODULE_VERSION ${deps.abi}) at ${deps.execPath}`,
    `  installed: ${installed}, in ${deps.addonDir}`,
    `  fetch:     ${fetchFailure}`,
    "Fix with one of:",
    `  - rebuild it for this Node:  PATH="${dirname(deps.execPath)}:$PATH" npm rebuild better-sqlite3 --prefix "${deps.qkbDir}"`,
    `  - reinstall qkb under Node ${runningMajor}:  npm install -g @miguelarios/qkb`,
  ];
  if (builtAbi && nodeMajorForAbi(builtAbi)) {
    lines.push(
      `  - launch qkb with the Node ${nodeMajorForAbi(builtAbi)} it was installed under (see the README's MCP setup)`,
    );
  }
  return lines.join("\n");
}

function message(e: unknown): string {
  return e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
}

function defaultDeps(): NativeDeps {
  const require = createRequire(import.meta.url);
  const addonPkgPath = require.resolve("better-sqlite3/package.json");
  const addonDir = dirname(addonPkgPath);
  const addonPkg = JSON.parse(readFileSync(addonPkgPath, "utf-8")) as { version: string };
  return {
    env: process.env,
    abi: process.versions.modules,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    addonVersion: addonPkg.version,
    addonDir,
    // dist/db/native.js (or src/db/native.ts) → package root.
    qkbDir: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    loadDefault: () => new Database(":memory:").close(),
    loadFrom: (path) => new Database(":memory:", { nativeBinding: path }).close(),
    fetchPrebuilt: (dest) => {
      // prebuild-install reads the package's name, version and repository
      // from ./package.json and extracts into ./build/Release.
      const bin = createRequire(addonPkgPath).resolve("prebuild-install/bin.js");
      writeFileSync(join(dest, "package.json"), readFileSync(addonPkgPath));
      process.stderr.write(
        `qkb: fetching better-sqlite3 for Node v${process.versions.node} (NODE_MODULE_VERSION ${process.versions.modules})...\n`,
      );
      // stdout must stay clean: under `qkb mcp` it is the JSON-RPC channel.
      const res = spawnSync(
        process.execPath,
        [bin, "--runtime", "node", "--target", process.versions.node, "--arch", process.arch],
        { cwd: dest, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, encoding: "utf-8" },
      );
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const detail = `${res.stderr}${res.stdout}`
          .split("\n")
          .filter((l) => /warn|err/i.test(l))
          .pop();
        throw new Error(
          `prebuild-install exited ${res.status}${detail ? `: ${detail.trim()}` : ""}`,
        );
      }
    },
  };
}

let memo: { value: string | undefined } | undefined;

/** `resolveNativeBinding()` for the real process, computed once. */
export function nativeBinding(): string | undefined {
  if (!memo) memo = { value: resolveNativeBinding() };
  return memo.value;
}
