import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_ABORT_MESSAGE,
  INGEST_ABORT_MESSAGE,
  reportAbortAndExit,
  summarizeSkips,
} from "../src/cli/ingest.js";
import { createProgram, readVersion } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const distCli = join(repoRoot, "dist", "cli.js");

const packageJson = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as {
  version: string;
};

describe("qkb --version", () => {
  it("readVersion() returns the version from package.json", () => {
    expect(readVersion()).toBe(packageJson.version);
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the package version to stdout when passed --version", () => {
    const program = createProgram();
    program.exitOverride();

    let output = "";
    program.configureOutput({
      writeOut: (str) => {
        output += str;
      },
    });

    let thrown: unknown;
    try {
      program.parse(["node", "qkb", "--version"]);
    } catch (err) {
      thrown = err;
    }

    // Commander's version action exits (via _exit) after printing; with
    // exitOverride() that surfaces as a thrown CommanderError instead of a
    // real process.exit, which is what makes this testable in-process.
    expect(thrown).toBeDefined();
    expect(output.trim()).toBe(packageJson.version);
  });
});

// Ports legacy/python/tests/test_cli.py — runs the REAL compiled CLI as a
// subprocess (spawnSync of `node dist/cli.js ...`), same spirit as Python's
// `CliRunner().invoke(cli, args, env=env, catch_exceptions=False)`: an
// offline, isolated run against a temp vault/db with the `fake` embedding
// provider (env-only overrides — see src/config.ts's ENV_MAP), asserting on
// exit code and captured output.
//
// Why a real subprocess instead of importing src/cli.ts's exports directly:
// (1) SIGINT/exit-code behavior is only observable at the process boundary;
// (2) it exercises the exact artifact a user runs (`npm run build` + `node
// dist/cli.js`), not just the TS source under vitest's esbuild transform —
// which matters here: this task's port of parser.ts's `js-yaml` import
// (`import * as yaml from "js-yaml"`) type-checked fine and passed under
// vitest, but crashed with a real `TypeError` under plain Node, because
// esbuild's CJS/ESM interop synthesizes named exports more permissively
// than Node's own does for this package. See src/ingest/parser.ts's import
// comment for the fix; this whole test file would not have caught that bug
// if it drove `createProgram()` in-process instead of a subprocess.
describe("qkb CLI (subprocess)", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }, 60_000);

  let tmpDir: string;
  let vault: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qkb-cli-test-"));
    vault = join(tmpDir, "vault");
    mkdirSync(vault, { recursive: true });
    env = {
      QKB_VAULT_PATH: vault,
      QKB_DB_PATH: join(tmpDir, "qkb.db"),
      QKB_EMBEDDING_PROVIDER: "fake",
      QKB_EMBEDDING_DIM: "8",
      QKB_CONFIG: join(tmpDir, "missing.toml"),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  interface RunResult {
    exitCode: number;
    output: string; // stdout + stderr merged, mirroring Click's CliRunner default (mix_stderr=True)
  }

  function run(args: string[], runEnv: Record<string, string> = env): RunResult {
    const result = spawnSync(process.execPath, [distCli, ...args], {
      env: { ...process.env, ...runEnv },
      encoding: "utf-8",
    });
    return {
      exitCode: result.status ?? -1,
      output: (result.stdout ?? "") + (result.stderr ?? ""),
    };
  }

  const ID1 = "f47ac10b-58cc-4372-a567-0e02b2c3d401";
  const ID2 = "f47ac10b-58cc-4372-a567-0e02b2c3d402";

  interface WriteOpts {
    context?: string;
    body?: string;
    extra?: string;
  }

  /** Spawns `node dist/cli.js ...args`, sends SIGINT after `delayMs`, and
   * resolves with the exit code + merged output once the process exits.
   * Unlike `run()` (spawnSync), this needs the child running concurrently
   * with the timer, hence a real `spawn` + Promise. */
  function runWithSigintAfter(
    args: string[],
    delayMs: number,
    runEnv: Record<string, string> = env,
  ): Promise<RunResult> {
    const child = spawn(process.execPath, [distCli, ...args], {
      env: { ...process.env, ...runEnv },
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    setTimeout(() => child.kill("SIGINT"), delayMs);
    return new Promise((resolve) => {
      child.on("exit", (code) => {
        resolve({ exitCode: code ?? -1, output });
      });
    });
  }

  function writeNote(name: string, noteId: string, opts: WriteOpts = {}): string {
    const { context = "homelab", body = "Some body text.", extra = "" } = opts;
    const p = join(vault, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      `---\nid: ${noteId}\ncontext: ${context}\ncreated: 2026-01-01T00:00:00-06:00\n${extra}---\n\n${body}\n`,
    );
    return p;
  }

  it("ingest then query --json", () => {
    writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    const ingested = run(["ingest"]);
    expect(ingested.exitCode).toBe(0);
    expect(ingested.output.toLowerCase()).toContain("indexed");

    const queried = run(["query", "traefik", "--json"]);
    expect(queried.exitCode).toBe(0);
    const results = JSON.parse(queried.output) as Array<Record<string, unknown>>;
    expect(results[0]?.document_id).toBe(ID1);
    expect(results[0]).toHaveProperty("obsidian_uri");
  });

  it("search --files format and context filter", () => {
    writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    run(["ingest"]);

    const hit = run(["search", "traefik", "--files", "--context", "homelab"]);
    expect(hit.exitCode).toBe(0);
    expect(hit.output.trim().split(",")[0]).toBe(ID1);

    const miss = run(["search", "traefik", "--files", "--context", "nonexistent"]);
    expect(miss.output.trim()).toBe("");
  });

  it("get, contexts, and status", () => {
    writeNote("a.md", ID1);
    run(["ingest"]);

    // `get` and `status` always emit JSON now (the dead --json flag on
    // `get` was removed — see the dedicated test below).
    const got = run(["get", ID1.slice(0, 8)]);
    expect((JSON.parse(got.output) as { document_id: string }).document_id).toBe(ID1);

    const described = run(["context", "describe", "homelab", "Home server notes"]);
    expect(described.exitCode).toBe(0);

    const contexts = run(["contexts", "--json"]);
    const rows = JSON.parse(contexts.output) as Array<{ context: string; description: string }>;
    expect(rows[0]?.context).toBe("homelab");
    expect(rows[0]?.description).toBe("Home server notes");

    const statusJson = run(["status", "--json"]);
    expect((JSON.parse(statusJson.output) as { documents: number }).documents).toBe(1);

    const statusHuman = run(["status"]);
    expect(statusHuman.exitCode).toBe(0);
    expect(statusHuman.output).toContain("Provider:");
    expect(statusHuman.output).toContain("fake");
  });

  it("context describe normalizes the label (trim + lowercase, via normalizeContext)", () => {
    writeNote("a.md", ID1);
    run(["ingest"]);

    const described = run(["context", "describe", "  Homelab  ", "Home server notes"]);
    expect(described.exitCode).toBe(0);

    const contexts = run(["contexts", "--json"]);
    const rows = JSON.parse(contexts.output) as Array<{ context: string; description: string }>;
    expect(rows[0]?.context).toBe("homelab");
    expect(rows[0]?.description).toBe("Home server notes");
  });

  it("context describe rejects an empty/whitespace-only label (exit code 2, like Click's UsageError)", () => {
    const result = run(["context", "describe", "   ", "desc"]);
    expect(result.exitCode).toBe(2);
  });

  it("get rejects the removed --json flag (exit code 2, like Click's UsageError); status still accepts it", () => {
    writeNote("a.md", ID1);
    run(["ingest"]);

    const got = run(["get", ID1.slice(0, 8), "--json"]);
    expect(got.exitCode).toBe(2);
    expect(got.output.toLowerCase()).toContain("no such option");

    const status = run(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect((JSON.parse(status.output) as { documents: number }).documents).toBe(1);
  });

  it("an unknown command exits with code 2, like Click's UsageError (fix round 1)", () => {
    const result = run(["nonexistent-command"]);
    expect(result.exitCode).toBe(2);
    expect(result.output.toLowerCase()).not.toContain("traceback");
  });

  it("--rerank is rejected as not-yet-configured (exit code 2)", () => {
    writeNote("a.md", ID1);
    run(["ingest"]);
    const result = run(["query", "anything", "--rerank"]);
    expect(result.exitCode).toBe(2);
  });

  it("--source filter", () => {
    writeNote("a.md", ID1, { body: "Renewing traefik certificates.", extra: "source: proj-a\n" });
    writeNote("b.md", ID2, { body: "Renewing traefik certificates.", extra: "source: proj-b\n" });
    run(["ingest"]);

    const hit = run(["search", "traefik", "--files", "--source", "proj-a"]);
    expect(hit.exitCode).toBe(0);
    const lines = hit.output
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.split(",")[0]).toBe(ID1);

    const miss = run(["search", "traefik", "--files", "--source", "nonexistent"]);
    expect(miss.output.trim()).toBe("");
  });

  it("rejects --limit 0 and negative limits with a clean error (no traceback)", () => {
    writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    run(["ingest"]);

    const zero = run(["search", "traefik", "--limit", "0"]);
    expect(zero.exitCode).toBe(2);
    expect(zero.output.toLowerCase()).not.toContain("traceback");

    const negative = run(["search", "traefik", "--limit", "-1"]);
    expect(negative.exitCode).toBe(2);
    expect(negative.output.toLowerCase()).not.toContain("traceback");
  });

  it("applies config's [search] default_limit when --limit is omitted", () => {
    writeFileSync(join(tmpDir, "config.toml"), "[search]\ndefault_limit = 1\n");
    const envWithConfig = { ...env, QKB_CONFIG: join(tmpDir, "config.toml") };
    writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    writeNote("b.md", ID2, { body: "Renewing traefik certificates too." });
    run(["ingest"], envWithConfig);

    const result = run(["search", "traefik", "--json"], envWithConfig);
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.output) as unknown[]).length).toBe(1);
  });

  it("get --raw on a note whose file moved/was deleted since ingest: clean error", () => {
    const notePath = writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    run(["ingest"]);
    unlinkSync(notePath);

    const result = run(["get", ID1.slice(0, 8), "--raw"]);
    expect(result.exitCode).toBe(1); // typed retrieval error, not a usage error — Click's ClickException convention
    expect(result.output.toLowerCase()).not.toContain("traceback");
    expect(result.output.toLowerCase()).toContain("qkb ingest");
  });

  it("status surfaces the index's built-with model and warns on mismatch", () => {
    writeNote("a.md", ID1);
    run(["ingest"]);
    run(["embed"]); // embedding is what commits the model/dim

    // configured model (default) != the fake provider's committed "fake-8d"
    const status = run(["status"]);
    expect(status.output).toContain("Built with: fake-8d");
    expect(status.output).toContain("qkb ingest --full");
    expect(status.output).toContain("⚠");

    const d = JSON.parse(run(["status", "--json"]).output) as {
      index_model: string;
      index_dim: number;
      model_mismatch: boolean;
    };
    expect(d.index_model).toBe("fake-8d");
    expect(d.index_dim).toBe(8);
    expect(d.model_mismatch).toBe(true);

    // aligned config -> no warning
    const env2 = { ...env, QKB_EMBEDDING_MODEL: "fake-8d" };
    const status2 = run(["status"], env2);
    expect(status2.output).not.toContain("⚠");
    const d2 = JSON.parse(run(["status", "--json"], env2).output) as { model_mismatch: boolean };
    expect(d2.model_mismatch).toBe(false);
  });

  it("ingest -v lists every skipped note; without -v it prints a hint instead", () => {
    // No `id:` -> NoteDataError -> skipped ("no id"), since the note is
    // opted in (has context) but unindexable.
    writeFileSync(
      join(vault, "no-id.md"),
      "---\ncontext: homelab\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nbody\n",
    );
    const quiet = run(["ingest"]);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.output).toContain("1 note(s) skipped");
    expect(quiet.output).toContain("qkb ingest -v");
    expect(quiet.output).not.toContain("no-id.md");

    writeFileSync(
      join(vault, "no-id2.md"),
      "---\ncontext: homelab\ncreated: 2026-01-01T00:00:00-06:00\n---\n\nbody2\n",
    );
    const verbose = run(["ingest", "-v"]);
    expect(verbose.exitCode).toBe(0);
    expect(verbose.output).toContain("no-id2.md");
  });

  // Fix round 1 (CLI review, IMPORTANT finding): a real SIGINT during
  // structural ingest used to never be observed at all — the old handler
  // called process.exit() directly, but the file loop had no event-loop
  // yield point for Node to ever run that handler during a run. Fixed via
  // a cooperative `AbortSignal` the pipeline checks (with a real yield)
  // once per file — see src/ingest/pipeline.ts. This is a genuine,
  // non-flaky real-process/real-signal test (not just the deterministic
  // pipeline-level ones in test/pipeline.test.ts): 1500 files makes
  // structural ingest take long enough (several hundred ms) that a SIGINT
  // sent after a fixed 400ms delay reliably lands mid-run — verified by
  // hand across 5 repeated runs with zero flakes before landing this
  // delay/count pair (see ts-task-15-report.md's "Fix round 1" section).
  it("real SIGINT during a large ingest run stops it partway, exits 130, and is resumable", async () => {
    for (let i = 0; i < 1500; i++) {
      writeNote(`note-${i}.md`, `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`, {
        body: `Note number ${i}.`,
      });
    }

    const aborted = await runWithSigintAfter(["ingest"], 400);
    expect(aborted.exitCode).toBe(130);
    expect(aborted.output).toContain("Aborted");
    expect(aborted.output).toContain("qkb ingest");

    const partial = JSON.parse(run(["status", "--json"]).output) as { documents: number };
    expect(partial.documents).toBeGreaterThan(0);
    // Genuinely stopped mid-run, not just slow to print+exit after
    // finishing everything.
    expect(partial.documents).toBeLessThan(1500);

    // Resuming with a plain ingest completes the rest — proves the abort
    // didn't corrupt anything and every already-processed file's commit
    // survived the interrupt (each upsert is its own transaction).
    const resumed = run(["ingest"]);
    expect(resumed.exitCode).toBe(0);
    const final = JSON.parse(run(["status", "--json"]).output) as { documents: number };
    expect(final.documents).toBe(1500);
  }, 20_000);

  it("mcp fails cleanly with a 'not implemented yet' message (Task 16 seam)", () => {
    const result = run(["mcp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output.toLowerCase()).not.toContain("traceback");
    expect(result.output.toLowerCase()).toContain("not implemented");
  });
});

// Unit tests for the CLI-level half of Ctrl-C handling: once the pipeline
// call (ingestVault/embedPending — see the deterministic cooperative-abort
// tests in test/pipeline.test.ts for the loop-level half) returns having
// stopped early, `reportAbortAndExit` is what decides to print the
// command-specific message and exit 130 instead of the normal success
// summary. Deterministic, no real signal or timing involved.
describe("reportAbortAndExit (unit)", () => {
  it("prints the ingest abort message and exits 130", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}__`);
    }) as never);

    expect(() => reportAbortAndExit(INGEST_ABORT_MESSAGE)).toThrow("__exit:130__");
    expect(logSpy).toHaveBeenCalledWith(INGEST_ABORT_MESSAGE);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Re-run `qkb ingest`");

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints the embed abort message and exits 130", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code}__`);
    }) as never);

    expect(() => reportAbortAndExit(EMBED_ABORT_MESSAGE)).toThrow("__exit:130__");
    expect(logSpy.mock.calls[0]?.[0]).toContain("Progress is saved");
    expect(logSpy.mock.calls[0]?.[0]).toContain("qkb embed");

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("summarizeSkips (unit)", () => {
  it("groups by reason, most-frequent first, and hints at -v", () => {
    const lines = summarizeSkips(
      [
        ["a.md", "no id"],
        ["b.md", "no date"],
        ["c.md", "no id"],
      ],
      false,
    );
    expect(lines[0]).toContain("3 note(s) skipped");
    expect(lines[1]).toContain("2 × no id");
    expect(lines[2]).toContain("1 × no date");
    expect(lines.some((l) => l.includes("qkb ingest -v"))).toBe(true);
    expect(lines.some((l) => l.includes("a.md"))).toBe(false);
  });

  it("lists every skipped file when verbose", () => {
    const lines = summarizeSkips([["a.md", "no id"]], true);
    expect(lines.some((l) => l.includes("a.md"))).toBe(true);
  });

  it("returns no lines when nothing was skipped", () => {
    expect(summarizeSkips([], false)).toEqual([]);
  });
});
