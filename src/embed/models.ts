/**
 * GGUF model resolution for the `llama` embedding provider.
 *
 * QMD-style: models are fetched once from HuggingFace into a local cache
 * dir and reused forever after. The download goes to a `.part` file and is
 * renamed into place atomically so an interrupted download never leaves a
 * truncated GGUF for llama.cpp to choke on.
 *
 * Ported from `legacy/python/src/qkb/embed/models.py`.
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export function ggufUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

export type FetchFn = (url: string, dest: string) => Promise<void>;

/** Streams `url` to `dest` via `fetchImpl` (defaults to the global `fetch`). */
export async function download(
  url: string,
  dest: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, { redirect: "follow" });
  } catch (e) {
    throw new Error(`model download failed for ${url}: ${e}`);
  }
  if (!resp.ok) {
    throw new Error(`model download failed for ${url}: HTTP ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) {
    throw new Error(`model download failed for ${url}: empty response body`);
  }
  try {
    await pipeline(
      Readable.fromWeb(resp.body as NodeWebReadableStream<Uint8Array>),
      createWriteStream(dest),
    );
  } catch (e) {
    throw new Error(`model download failed for ${url}: ${e}`);
  }
}

/** Returns the local path of the GGUF, downloading it on first use. */
export async function ensureModel(
  repo: string,
  filename: string,
  cacheDir: string,
  fetch: FetchFn = (url, dest) => download(url, dest),
): Promise<string> {
  const target = join(cacheDir, filename);
  if (existsSync(target) && statSync(target).isFile()) {
    return target;
  }
  await mkdir(cacheDir, { recursive: true });
  const url = ggufUrl(repo, filename);
  process.stderr.write(`qkb: downloading embedding model ${filename} to ${cacheDir} ...\n`);
  const tmp = `${target}.part`;
  try {
    await fetch(url, tmp);
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  process.stderr.write(`qkb: model cached at ${target}\n`);
  return target;
}
