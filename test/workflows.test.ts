import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// Cheap, offline substitute for `actionlint`: every workflow file must at
// least be syntactically valid YAML with a `jobs` map, and the release safety
// invariants (npm publishes only when a merged version bump or a v* tag says
// so, via OIDC; CI never `npm publish`es; no Python/PyPI workflow comes back
// now that the repo is TypeScript-only) must hold structurally, not just by
// convention.

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
      ["ci.yml", "claude-code-review.yml", "gitleaks.yml", "release.yml"].sort(),
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
  const jobs = doc.jobs as Record<string, Record<string, unknown>>;
  const steps = (jobs.release?.steps ?? []) as Record<string, unknown>[];
  const plan = String(steps.find((s) => s.id === "plan")?.run ?? "");

  it("runs on pushes to main (release on merge) and v* tags (manual fallback), never on pull_request", () => {
    const on = doc.on as Record<string, unknown>;
    expect(on.pull_request).toBeUndefined();
    expect(on.pull_request_target).toBeUndefined();
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toEqual(["main"]);
    expect(push.tags).toEqual(["v*"]);
  });

  it("publishes only when package.json's version changed (or a matching v* tag was pushed)", () => {
    // A plain push to main must never publish — only merging a version bump
    // (owner-only) or pushing a tag does.
    expect(plan).toMatch(/OLD" = "\$VERSION"/);
    expect(plan).toMatch(/release=false/);
    expect(plan).toMatch(/Refusing to publish: tag/);
    const gated = steps.filter((s) => s.run !== undefined && s.id !== "plan");
    for (const s of gated) {
      expect(String(s.if ?? "")).toMatch(/steps\.plan\.outputs\.release == 'true'/);
    }
    const publish = steps.find((s) => s.name === "Publish");
    expect(String(publish?.if ?? "")).toMatch(/steps\.exists\.outputs\.already == 'false'/);
  });

  it("tags only after npm serves the version", () => {
    const tag = String(steps.find((s) => s.name === "Tag and GitHub Release")?.run ?? "");
    expect(tag.indexOf("npm view")).toBeGreaterThan(-1);
    expect(tag.indexOf("npm view")).toBeLessThan(tag.indexOf("git push origin"));
  });

  it("requests OIDC id-token permission for npm trusted publishing", () => {
    const perms = jobs.release?.permissions as Record<string, string> | undefined;
    expect(perms?.["id-token"]).toBe("write");
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

describe("no Python tooling", () => {
  it.each(readdirSync(WORKFLOWS_DIR))("%s never installs Python or publishes to PyPI", (file) => {
    const text = readFileSync(join(WORKFLOWS_DIR, file), "utf-8");
    expect(text).not.toMatch(/setup-python|pypi|pip install|uv (tool|pip|sync)/i);
  });
});
