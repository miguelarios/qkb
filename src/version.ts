import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Reads the package version from package.json, which sits one level up
 * from this file both as compiled (`dist/version.js`) and as source
 * (`src/version.ts` run directly). */
export function readVersion(): string {
  const packageJsonPath = join(here, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version: string;
  };
  return packageJson.version;
}
