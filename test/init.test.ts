import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discoverVaults, parseVaultArg, starterConfig } from "../src/cli/init.js";
import { configuredVaults, loadConfig } from "../src/config.js";

const repoRoot = join(import.meta.dirname, "..");
const distCli = join(repoRoot, "dist", "cli.js");

describe("qkb init", () => {
  let tmp: string;

  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }, 60_000);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qkb-init-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function init(args: string[], configPath: string) {
    return spawnSync(process.execPath, [distCli, "init", ...args], {
      env: { ...process.env, QKB_CONFIG: configPath },
      encoding: "utf-8",
    });
  }

  it("the starter config loads, with names YAML would misread kept as strings", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(
      path,
      starterConfig([
        { name: "2024", path: "/vaults/2024" },
        { name: "Home Lab: notes", path: "/vaults/Home Lab" },
      ]),
    );
    const cfg = loadConfig(path, {});
    expect(configuredVaults(cfg)).toEqual([
      { name: "2024", path: "/vaults/2024", includeByDefault: true },
      { name: "Home Lab: notes", path: "/vaults/Home Lab", includeByDefault: true },
    ]);
    expect(cfg.embeddingProvider).toBe("llama");
  });

  it("with no vault given, the starter config points at ~/Notes", () => {
    const path = join(tmp, "config.yaml");
    writeFileSync(path, starterConfig([]));
    expect(configuredVaults(loadConfig(path, {})).map((v) => v.name)).toEqual(["Notes"]);
  });

  it("reads a vault argument as Name=/path or a bare path", () => {
    expect(parseVaultArg("Work=/srv/work notes")).toEqual({
      name: "Work",
      path: "/srv/work notes",
    });
    expect(parseVaultArg("/srv/Personal")).toEqual({ name: "Personal", path: "/srv/Personal" });
    // A path containing `=` is still a path, and a relative one is made absolute.
    expect(parseVaultArg("/srv/a=b/notes")).toEqual({ name: "notes", path: "/srv/a=b/notes" });
    expect(parseVaultArg("rel/Notes")).toEqual({
      name: "Notes",
      path: join(process.cwd(), "rel/Notes"),
    });
    expect(parseVaultArg("~/Notes")).toEqual({ name: "Notes", path: "~/Notes" });
  });

  it("lists the subdirectories of a vaults directory, skipping files and dot-directories", () => {
    mkdirSync(join(tmp, "Work"));
    mkdirSync(join(tmp, "Notes"));
    mkdirSync(join(tmp, ".trash"));
    writeFileSync(join(tmp, "readme.md"), "x");
    expect(discoverVaults(tmp)).toEqual([
      { name: "Notes", path: join(tmp, "Notes") },
      { name: "Work", path: join(tmp, "Work") },
    ]);
    expect(discoverVaults(join(tmp, "missing"))).toEqual([]);
  });

  it("writes the config once and leaves an existing one alone unless --force", () => {
    const vaults = join(tmp, "vaults");
    mkdirSync(join(vaults, "Notes"), { recursive: true });
    const path = join(tmp, "nested", "config.yaml");

    const first = init(["--vaults-dir", vaults], path);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(""); // stdout stays clean for a server started next
    expect(configuredVaults(loadConfig(path, {}))[0]?.path).toBe(join(vaults, "Notes"));

    writeFileSync(path, "vault:\n  name: Mine\n");
    const second = init(["--quiet", "--vault", "/elsewhere"], path);
    expect(second.status).toBe(0);
    expect(second.stdout + second.stderr).toBe("");
    expect(readFileSync(path, "utf-8")).toBe("vault:\n  name: Mine\n");

    expect(init(["--force", "--vault", "Other=/elsewhere"], path).status).toBe(0);
    expect(configuredVaults(loadConfig(path, {}))[0]?.name).toBe("Other");
  });

  it("leaves a legacy config.toml beside the YAML path alone, even with --force", () => {
    const toml = '[vault]\nname = "Old"\n';
    writeFileSync(join(tmp, "config.toml"), toml);
    const r = init(["--quiet"], join(tmp, "config.yaml"));
    expect(r.status).toBe(0);
    expect(() => readFileSync(join(tmp, "config.yaml"))).toThrow();

    const forced = init(["--force"], join(tmp, "config.yaml"));
    expect(forced.status).toBe(2);
    expect(forced.stderr).toContain("legacy TOML config");
    expect(readFileSync(join(tmp, "config.toml"), "utf-8")).toBe(toml);
  });

  it("refuses a vaults directory with no vault folders instead of writing a placeholder", () => {
    writeFileSync(join(tmp, "stray.md"), "x");
    const path = join(tmp, "out", "config.yaml");
    const r = init(["--vaults-dir", tmp], path);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no vault folders found");
    expect(() => readFileSync(path)).toThrow();
  });

  it("refuses two vaults with the same name", () => {
    const r = init(["--vault", "/a/Notes", "--vault", "/b/Notes"], join(tmp, "config.yaml"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('two vaults are named "Notes"');
  });
});
