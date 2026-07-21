import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// Cheap, offline substitute for `actionlint`: every workflow file must at
// least be syntactically valid YAML with a `jobs` map, and the safety
// invariants this task's brief calls out (never resurrect an auto `v*`
// PyPI trigger; the npm release workflow is tag-gated, uses OIDC, and CI
// never `npm publish`s) must hold structurally, not just by convention.

const WORKFLOWS_DIR = join(import.meta.dirname, "..", ".github", "workflows");

function loadWorkflow(file: string): Record<string, unknown> {
  const text = readFileSync(join(WORKFLOWS_DIR, file), "utf-8");
  const doc = yaml.load(text);
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`${file}: did not parse to a YAML mapping`);
  }
  return doc as Record<string, unknown>;
}

describe("workflow YAML is well-formed", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("found the expected workflow files", () => {
    expect(files.sort()).toEqual(
      [
        "ci-legacy-python.yml",
        "ci.yml",
        "gitleaks.yml",
        "release-python.yml",
        "release.yml",
      ].sort(),
    );
  });

  it.each(files)("%s parses as YAML with a top-level `jobs` map", (file) => {
    const doc = loadWorkflow(file);
    expect(doc.jobs).toBeTypeOf("object");
    expect(doc.jobs).not.toBeNull();
  });
});

describe("ci.yml", () => {
  const doc = loadWorkflow("ci.yml");

  it("runs on push to main and on pull_request, never on tags", () => {
    // js-yaml parses the bare `on:` key as the boolean `true` (YAML 1.1
    // truthy scalar) — read via the string key regardless.
    const on = doc.on as Record<string, unknown>;
    expect(on.push).toBeTypeOf("object");
    expect((on.push as Record<string, unknown>).tags).toBeUndefined();
    expect(on).toHaveProperty("pull_request");
  });

  it("never calls npm publish", () => {
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/npm publish/);
  });

  it("runs npm run build so build-config regressions surface in PR CI", () => {
    const text = JSON.stringify(doc);
    expect(text).toMatch(/npm run build/);
  });
});

describe("release.yml", () => {
  const doc = loadWorkflow("release.yml");

  it("triggers only on v* tag pushes, not on branch pushes or pull_request", () => {
    const on = doc.on as Record<string, unknown>;
    expect(on.pull_request).toBeUndefined();
    const push = on.push as Record<string, unknown>;
    expect(push).toBeTypeOf("object");
    expect(push.branches).toBeUndefined();
    expect(push.tags).toEqual(["v*"]);
  });

  it("requests OIDC id-token permission for npm trusted publishing", () => {
    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    const permissioned = Object.values(jobs).some((job) => {
      const perms = job.permissions as Record<string, string> | undefined;
      return perms?.["id-token"] === "write";
    });
    expect(permissioned).toBe(true);
  });

  it("publishes with --provenance --access public and no token secret", () => {
    const text = JSON.stringify(doc);
    expect(text).toMatch(/npm publish/);
    expect(text).toMatch(/--provenance/);
    expect(text).toMatch(/--access(\s|['"]| )public|--access.{0,3}public/);
    // No NODE_AUTH_TOKEN / NPM_TOKEN wiring — trusted publishing needs none.
    expect(text).not.toMatch(/NODE_AUTH_TOKEN/);
    expect(text).not.toMatch(/NPM_TOKEN/);
  });

  it("creates a GitHub Release", () => {
    const text = JSON.stringify(doc);
    expect(text).toMatch(/gh-release|gh release create/);
  });
});

describe("release-python.yml stays disarmed", () => {
  const doc = loadWorkflow("release-python.yml");

  it("is workflow_dispatch-only — no automatic v* tag trigger", () => {
    const on = doc.on as Record<string, unknown> | string;
    if (typeof on === "object" && on !== null) {
      expect(on).toHaveProperty("workflow_dispatch");
      expect(on).not.toHaveProperty("push");
    } else {
      expect(on).toBe("workflow_dispatch");
    }
  });
});
