import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

  it("runs when invoked through a symlink to dist/cli.js — the npm global-install shape", () => {
    // `npm i -g` installs the `qkb` bin as a SYMLINK into dist/cli.js.
    // Node's ESM loader resolves the *entry point* to its realpath before
    // setting import.meta.url, but process.argv[1] stays the symlink path
    // — so src/cli.ts's main-module check must resolve the symlink too
    // (realpathSync), or `main()` silently never runs: exit 0, no output,
    // no error, and a globally-installed `qkb` does nothing at all.
    // Empirically confirmed failing (silent no-op) before that fix.
    const binDir = join(tmpDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const symlinkPath = join(binDir, "qkb");
    symlinkSync(distCli, symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath, "--version"], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect((result.stdout ?? "").trim()).toBe(packageJson.version);
  });

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

  // Issue #14: human search output shows per-result match evidence, a
  // relative-percentage score column, and a context-name tip — all
  // presentation-only; --json/--files must stay byte-identical (pinned
  // separately below).
  describe("human search output (issue #14)", () => {
    it("shows a clipped evidence line with [markers] kept for a real body match", () => {
      writeNote("a.md", ID1, {
        body: "Renewing traefik certificates for the homelab reverse proxy.",
      });
      run(["ingest"]);

      const result = run(["search", "traefik", "--context", "homelab"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("[traefik]");
      // no raw-score column and no old "Title: snippet" trailing block
      expect(result.output).not.toMatch(/^a: /m);
    });

    it("shows a match attribution (not document-head noise) for a metadata-column-only match", () => {
      // "homelab-traefik" only appears in frontmatter (context), never in
      // the body, so the FTS5 body snippet degrades to the document's
      // opening words with no [markers] — the old behavior printed that
      // noise verbatim; the new behavior must attribute the hit instead.
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "Some unrelated body text about DNS and adguard configuration.",
      });
      run(["ingest"]);

      const result = run(["search", "homelab-traefik"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('matched: context "homelab-traefik"');
      // must NOT print the useless body-head snippet
      expect(result.output).not.toContain("Some unrelated body text");
    });

    it("does not mistake a body's literal markdown brackets for match markers (checklist + wikilink opening, context-only match)", () => {
      // Reviewer-proven bracket-sniffing bug: a body that legitimately
      // OPENS with `- [ ]` checklist syntax and a `[[wikilink]]` contains
      // literal `[`/`]` that have nothing to do with the actual match (the
      // query only matches the context column) — bracket-sniffing
      // `matched_text` for "was this a real hit" printed that checklist
      // text as if it were highlighted evidence. Real match markers must be
      // an internal signal the document's own content can never produce.
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "- [ ] buy milk\nSee [[grocery list]] for more.",
      });
      run(["ingest"]);

      const result = run(["search", "homelab-traefik"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('matched: context "homelab-traefik"');
      // must NOT print the checklist/wikilink body text as if it were
      // real match evidence.
      expect(result.output).not.toContain("buy milk");
      expect(result.output).not.toContain("grocery list");
    });

    it("prints relative percentage scores (top result = 100%), not raw scores", () => {
      writeNote("a.md", ID1, { body: "traefik traefik traefik certificate renewal notes" });
      writeNote("b.md", ID2, { body: "a passing mention of traefik once" });
      run(["ingest"]);

      const result = run(["search", "traefik"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("100%");
      // no raw BM25 float (e.g. "0.0000") anywhere in the table
      expect(result.output).not.toMatch(/\b\d+\.\d{4,}\b/);
    });

    it('prints the "is a context" tip on stderr when the query exactly equals a context name', () => {
      writeNote("a.md", ID1, { context: "homelab-traefik", body: "Renewing certificates." });
      run(["ingest"]);

      const result = run(["search", "homelab-traefik"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        'tip: "homelab-traefik" is a context — use --context homelab-traefik to browse it',
      );
    });

    it("does NOT print the context tip for an ordinary query that isn't a context name", () => {
      writeNote("a.md", ID1, { context: "homelab-traefik", body: "Renewing certificates." });
      run(["ingest"]);

      const result = run(["search", "certificates"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("is a context");
    });

    it("does NOT print the context tip when the query matches a context name but there are zero results", () => {
      writeNote("a.md", ID1, { context: "homelab-traefik", body: "Renewing certificates." });
      run(["ingest"]);

      // "empty-context" isn't a real context and matches nothing.
      const result = run(["search", "empty-context"]);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("is a context");
    });

    it("does NOT print the context tip for --json or --files output", () => {
      writeNote("a.md", ID1, { context: "homelab-traefik", body: "Renewing certificates." });
      run(["ingest"]);

      const asJson = run(["search", "homelab-traefik", "--json"]);
      expect(asJson.output).not.toContain("is a context");
      JSON.parse(asJson.output); // still valid, unadorned JSON

      const asFiles = run(["search", "homelab-traefik", "--files"]);
      expect(asFiles.output).not.toContain("is a context");
    });

    it("--json output is unaffected by the evidence/score/tip changes (byte-identical contract)", () => {
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "Renewing traefik certificates for the homelab reverse proxy.",
      });
      run(["ingest"]);

      const result = run(["search", "traefik", "--json"]);
      expect(result.exitCode).toBe(0);
      const results = JSON.parse(result.output) as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]?.document_id).toBe(ID1);
      // raw score still a plain unbounded float, never a "NN%" string
      expect(typeof results[0]?.score).toBe("number");
      expect(results[0]?.matched_text).toContain("[traefik]");
      // nothing besides valid JSON on stdout+stderr
      expect(result.output.trim().startsWith("[")).toBe(true);
    });

    it("--json matched_text round-trips a real match byte-exact to public [markers], with no internal control-char markers leaked, even with unrelated literal brackets in the body (checklist/wikilink)", () => {
      // searchBm25 marks a real hit internally with control chars, not
      // literal `[`/`]` (issue #14 critical fix), specifically so a body's
      // own literal brackets (checklist/wikilink markdown, here placed
      // right next to the real match so both land in the same snippet
      // window) can never be confused with a match marker. The public
      // `--json` contract must still show plain `[traefik]` (Python
      // parity) — and must never leak the raw internal control bytes.
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "- [ ] buy milk. Renewing traefik [[cert-tracker]] certificates for the homelab reverse proxy.",
      });
      run(["ingest"]);

      const result = run(["search", "traefik", "--json"]);
      expect(result.exitCode).toBe(0);
      const results = JSON.parse(result.output) as Array<{ matched_text: string }>;
      expect(results[0]?.matched_text).toContain("[traefik]");
      // the body's own literal brackets pass through untouched too
      expect(results[0]?.matched_text).toContain("[[cert-tracker]]");
      // No raw internal control-char markers ever leak into public bytes.
      // Plain substring checks built via String.fromCharCode, not a regex
      // literal -- biome's noControlCharactersInRegex rule (rightly)
      // disallows control chars inside a regex pattern.
      expect(result.output.includes(String.fromCharCode(1))).toBe(false);
      expect(result.output.includes(String.fromCharCode(2))).toBe(false);
    });

    it("--json matched_text for a marker-less (metadata-only) match stays the plain document-head snippet — no stray brackets inserted, no leaked control chars", () => {
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "Some unrelated body text about DNS and adguard configuration.",
      });
      run(["ingest"]);

      const result = run(["search", "homelab-traefik", "--json"]);
      expect(result.exitCode).toBe(0);
      const results = JSON.parse(result.output) as Array<{ matched_text: string | null }>;
      expect(results[0]?.matched_text).toContain("Some unrelated body text");
      const text = results[0]?.matched_text ?? "";
      expect(text.includes(String.fromCharCode(1))).toBe(false);
      expect(text.includes(String.fromCharCode(2))).toBe(false);
    });

    it("--files output is unaffected by the evidence/score/tip changes (byte-identical contract)", () => {
      writeNote("a.md", ID1, {
        context: "homelab-traefik",
        body: "Renewing traefik certificates for the homelab reverse proxy.",
      });
      run(["ingest"]);

      const result = run(["search", "traefik", "--files"]);
      expect(result.exitCode).toBe(0);
      const line = result.output.trim();
      expect(line.split(",")[0]).toBe(ID1);
      expect(line).not.toContain("%");
      expect(line).not.toContain("matched:");
    });
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

  it("qkb embed with nothing pending never warms the provider — safe offline even with provider=llama (the network-touching default)", () => {
    // Deliberately builds its own env WITHOUT `QKB_EMBEDDING_PROVIDER: fake`
    // (every other test in this file sets it) and pins `provider: llama`
    // explicitly instead — llama is also config.ts's actual default, so this
    // doubles as "the out-of-the-box config never surprises a fully-embedded
    // vault with a model load/download". Provider CONSTRUCTION
    // (`getProvider()`) is always I/O-free; LlamaProvider only resolves/
    // downloads its GGUF on the first real `embed()`/warmup call (see
    // src/embed/llama.ts's docstring) — so this test would hang/fail offline
    // in CI without the pending-check-before-warmup fix, since the old code
    // unconditionally called `provider.embed(["warmup"])` before checking
    // whether there was anything to embed.
    const envWithLlama: Record<string, string> = {
      QKB_VAULT_PATH: vault,
      QKB_DB_PATH: join(tmpDir, "qkb.db"),
      QKB_CONFIG: join(tmpDir, "missing.toml"),
      QKB_EMBEDDING_PROVIDER: "llama",
    };
    // Empty vault -> `ingest` produces zero chunks -> nothing pending.
    const ingested = run(["ingest"], envWithLlama);
    expect(ingested.exitCode).toBe(0);

    const embedded = run(["embed"], envWithLlama);
    expect(embedded.exitCode).toBe(0);
    expect(embedded.output).toContain("✓ all chunks already embedded");
    expect(embedded.output).not.toContain("Loading embedding model");
  });

  it("qkb embed with nothing pending but a CHANGED model still fails the model/dim guard (exit 1, --full remedy) — no warmup attempted", () => {
    // The pending-work optimization above must never shortcut the
    // model/dim consistency guard: it lives inside embedPending() and has
    // to run unconditionally (mirrors pipeline.py's embed_pending
    // ordering — guard first, then the 0-pending no-op), so a config
    // change with nothing NEW to embed still surfaces as a loud error
    // instead of a silent, wrong "already embedded". Uses the `fake`
    // provider on both sides purely so the guard failure itself is
    // reachable offline in CI; changing `QKB_EMBEDDING_DIM` changes
    // FakeProvider's reported modelName (`fake-${dim}d`), which is enough
    // to trigger the same mismatch a real model swap would.
    writeNote("a.md", ID1, { body: "Renewing traefik certificates." });
    run(["ingest"]);
    const firstEmbed = run(["embed"]); // commits "fake-8d" @ dim 8, 0 pending left
    expect(firstEmbed.exitCode).toBe(0);

    const changedModelEnv = { ...env, QKB_EMBEDDING_DIM: "16" };
    const result = run(["embed"], changedModelEnv);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Embedding model/dim changed");
    expect(result.output).toContain("qkb embed --full");
    expect(result.output).not.toContain("Loading embedding model");
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

  // Task 16 replaced the seam stub with the real MCP server (src/server/mcp.ts)
  // — test/mcp.test.ts covers tool behavior in-process over an InMemoryTransport
  // pair (fast, no subprocess). This test instead proves the OTHER half of the
  // acceptance criterion — "`qkb mcp` starts the stdio server" — by spawning
  // the real compiled CLI and talking to it as a genuine MCP client would:
  // over stdio, real JSON-RPC framing, real process boundary. `run()`
  // (spawnSync) can't drive this: `qkb mcp` is long-lived and never exits on
  // its own, so this uses the SDK's own `StdioClientTransport` (spawns the
  // command, speaks the wire protocol) instead.
  it("qkb mcp starts a real stdio server exposing qkb/qkb_get/qkb_status (Task 16)", async () => {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) {
      if (v !== undefined) childEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distCli, "mcp"],
      env: childEnv,
    });
    const client = new Client({ name: "qkb-cli-test-client", version: "0.1.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      expect(names.has("qkb")).toBe(true);
      expect(names.has("qkb_get")).toBe(true);
      expect(names.has("qkb_status")).toBe(true);

      const result = await client.callTool({ name: "qkb_status", arguments: {} });
      const content = result.content as { type: string; text: string }[];
      const payload = JSON.parse(content[0]?.text ?? "null") as { documents: number };
      expect(payload.documents).toBe(0);
    } finally {
      await client.close();
    }
  }, 15_000);
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
