import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let cached: string | undefined;

/** Reads the package version from package.json, which sits one level up
 * from this file both as compiled (`dist/version.js`) and as source
 * (`src/version.ts` run directly). Read once: the stateless HTTP transport
 * builds a fresh MCP server, and so asks for the version, on every request. */
export function readVersion(): string {
  if (cached === undefined) {
    const packageJsonPath = join(here, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version: string;
    };
    cached = packageJson.version;
  }
  return cached;
}
