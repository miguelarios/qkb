#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

// This is a scaffolding stub (Task 1 of the TypeScript rewrite — see
// docs/plans/2026-07-20-typescript-rewrite.md). It only wires up `--version`;
// the real subcommands (ingest, embed, search, ...) land in Task 15.

const here = dirname(fileURLToPath(import.meta.url));

/** Reads the package version from package.json, which sits one level up
 * from this file both as compiled (`dist/cli.js`) and as source
 * (`src/cli.ts` run directly). */
export function readVersion(): string {
  const packageJsonPath = join(here, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version: string;
  };
  return packageJson.version;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("qkb")
    .description("Hybrid BM25 + vector search for Obsidian vaults")
    .version(readVersion(), "--version", "print the qkb version");
  return program;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  createProgram().parse(process.argv);
}
