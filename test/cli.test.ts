import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram, readVersion } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
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
