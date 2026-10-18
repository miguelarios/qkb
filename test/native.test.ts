import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addonAbiFromError,
  isAddonLoadError,
  NativeAddonError,
  type NativeDeps,
  nativeCacheDir,
  nodeMajorForAbi,
  resolveNativeBinding,
} from "../src/db/native.js";

// The real loader error Node throws for an addon built against another ABI
// (captured from better-sqlite3 built under Node 26 and loaded by Node 22).
function abiMismatchError(): Error {
  const err = new Error(
    "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      "was compiled against a different Node.js version using\n" +
      "NODE_MODULE_VERSION 127. This version of Node.js requires\n" +
      "NODE_MODULE_VERSION 147. Please try re-compiling or re-installing\n" +
      "the module (for instance, using `npm rebuild` or `npm install`).",
  ) as Error & { code: string };
  err.code = "ERR_DLOPEN_FAILED";
  return err;
}

describe("addon load error classification", () => {
  it("recognises an ABI mismatch and reads the ABI the addon was built for", () => {
    const err = abiMismatchError();
    expect(isAddonLoadError(err)).toBe(true);
    expect(addonAbiFromError(err)).toBe("127");
  });

  it("recognises a missing binary (install scripts skipped)", () => {
    const err = new Error(
      "Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node",
    );
    expect(isAddonLoadError(err)).toBe(true);
    expect(addonAbiFromError(err)).toBeUndefined();
  });

  it("leaves unrelated errors alone", () => {
    expect(isAddonLoadError(new Error("SQLITE_CANTOPEN"))).toBe(false);
    expect(isAddonLoadError("nope")).toBe(false);
  });

  it("maps known ABIs to Node majors", () => {
    expect(nodeMajorForAbi("127")).toBe("22");
    expect(nodeMajorForAbi("147")).toBe("26");
    expect(nodeMajorForAbi("9999")).toBeUndefined();
  });
});

describe("nativeCacheDir", () => {
  it("honours QKB_NATIVE_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache", () => {
    expect(nativeCacheDir({ QKB_NATIVE_CACHE_DIR: "/a" }, "/home/u")).toBe("/a");
    expect(nativeCacheDir({ XDG_CACHE_HOME: "/xdg" }, "/home/u")).toBe("/xdg/qkb/native");
    expect(nativeCacheDir({}, "/home/u")).toBe("/home/u/.cache/qkb/native");
  });
});

describe("resolveNativeBinding", () => {
  let cache: string;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "qkb-native-"));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  function deps(overrides: Partial<NativeDeps> = {}): NativeDeps {
    return {
      env: { QKB_NATIVE_CACHE_DIR: cache },
      abi: "147",
      nodeVersion: "26.7.0",
      execPath: "/opt/node26/bin/node",
      platform: "darwin",
      arch: "arm64",
      addonVersion: "12.11.1",
      addonDir: "/x/node_modules/better-sqlite3",
      qkbDir: "/x",
      loadDefault: () => {},
      loadFrom: () => {},
      fetchPrebuilt: () => {
        throw new Error("fetchPrebuilt should not run");
      },
      ...overrides,
    };
  }

  const expected = () =>
    join(
      cache,
      "better-sqlite3-12.11.1",
      "node-v147-darwin-arm64",
      "build",
      "Release",
      "better_sqlite3.node",
    );

  it("returns undefined when the installed addon loads", () => {
    expect(resolveNativeBinding(deps())).toBeUndefined();
  });

  it("rethrows errors that are not addon load failures", () => {
    const boom = new Error("boom");
    expect(() =>
      resolveNativeBinding(
        deps({
          loadDefault: () => {
            throw boom;
          },
        }),
      ),
    ).toThrow(boom);
  });

  it("uses an already-cached binary for this ABI without fetching", () => {
    mkdirSync(dirname(expected()), { recursive: true });
    writeFileSync(expected(), "");
    const loaded: string[] = [];
    const path = resolveNativeBinding(
      deps({
        loadDefault: () => {
          throw abiMismatchError();
        },
        loadFrom: (p) => {
          loaded.push(p);
        },
      }),
    );
    expect(path).toBe(expected());
    expect(loaded).toEqual([expected()]);
  });

  it("fetches the prebuilt binary for this Node into the cache on a mismatch", () => {
    const path = resolveNativeBinding(
      deps({
        loadDefault: () => {
          throw abiMismatchError();
        },
        fetchPrebuilt: (dest) => {
          const file = join(dest, "build", "Release", "better_sqlite3.node");
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, "");
        },
      }),
    );
    expect(path).toBe(expected());
  });

  it("explains both Node versions and the fix when no binary can be fetched", () => {
    let err: unknown;
    try {
      resolveNativeBinding(
        deps({
          loadDefault: () => {
            throw abiMismatchError();
          },
          fetchPrebuilt: () => {
            throw new Error("404 Not Found");
          },
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NativeAddonError);
    const msg = (err as Error).message;
    expect(msg).toContain("v26.7.0");
    expect(msg).toContain("NODE_MODULE_VERSION 147");
    expect(msg).toContain("NODE_MODULE_VERSION 127 (Node 22)");
    expect(msg).toContain("404 Not Found");
    expect(msg).toContain("npm rebuild better-sqlite3");
  });

  it("does not download when QKB_NATIVE_DOWNLOAD=0", () => {
    expect(() =>
      resolveNativeBinding(
        deps({
          env: { QKB_NATIVE_CACHE_DIR: cache, QKB_NATIVE_DOWNLOAD: "0" },
          loadDefault: () => {
            throw abiMismatchError();
          },
        }),
      ),
    ).toThrow(/QKB_NATIVE_DOWNLOAD=0/);
  });
});
