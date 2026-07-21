import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { download, ensureModel, ggufUrl } from "../../src/embed/models.js";

// Ports legacy/python/tests/test_embed_models.py. Offline: the network fetch
// is injected; `download`'s use of the real global fetch is exercised
// against an injected fetchImpl standing in for the HTTP layer.
describe("embed/models", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), "qkb-models-"));
  });

  afterEach(() => {
    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("builds the HuggingFace resolve URL", () => {
    expect(ggufUrl("example-org/some-model-GGUF", "some-model-Q8_0.gguf")).toBe(
      "https://huggingface.co/example-org/some-model-GGUF/resolve/main/some-model-Q8_0.gguf",
    );
  });

  it("returns the cached file without fetching", async () => {
    const target = join(tmpPath, "model.gguf");
    writeFileSync(target, "GGUF-bytes");

    const fetch = async () => {
      throw new Error("fetch called despite cached model");
    };

    const path = await ensureModel("example-org/x", "model.gguf", tmpPath, fetch);
    expect(path).toBe(target);
  });

  it("downloads then renames atomically, creating the cache dir", async () => {
    const calls: Array<[string, string]> = [];
    const cache = join(tmpPath, "models"); // does not exist yet

    const fetch = async (url: string, dest: string) => {
      calls.push([url, dest]);
      writeFileSync(dest, "GGUF-bytes");
    };

    const path = await ensureModel("example-org/x", "model.gguf", cache, fetch);

    expect(path).toBe(join(cache, "model.gguf"));
    expect(readFileSync(path, "utf-8")).toBe("GGUF-bytes");
    expect(calls).toEqual([
      [
        "https://huggingface.co/example-org/x/resolve/main/model.gguf",
        join(cache, "model.gguf.part"),
      ],
    ]);
    expect(existsSync(join(cache, "model.gguf.part"))).toBe(false);
  });

  it("cleans up the partial file on fetch failure and does not create the target", async () => {
    mkdirSync(tmpPath, { recursive: true });
    const fetch = async (_url: string, dest: string) => {
      writeFileSync(dest, "trunc");
      throw new Error("network died");
    };

    await expect(ensureModel("example-org/x", "model.gguf", tmpPath, fetch)).rejects.toThrow(
      "network died",
    );
    expect(existsSync(join(tmpPath, "model.gguf"))).toBe(false);
    expect(existsSync(join(tmpPath, "model.gguf.part"))).toBe(false);
  });

  it("streams the response body to dest via the injected fetch", async () => {
    const dest = join(tmpPath, "model.gguf.part");
    const fakeFetch: typeof fetch = async (_url, _init) =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });

    await download("https://huggingface.co/example/resolve/main/model.gguf", dest, fakeFetch);
    expect(new Uint8Array(readFileSync(dest))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("wraps a mid-stream connection drop with the 'download failed' message", async () => {
    const dest = join(tmpPath, "model.gguf.part");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new Error("connection reset"));
      },
    });
    const fakeFetch: typeof fetch = async () => new Response(stream, { status: 200 });

    await expect(
      download("https://huggingface.co/example/resolve/main/model.gguf", dest, fakeFetch),
    ).rejects.toThrow(/download failed/);
  });

  it("raises with a 'download failed' message on an HTTP error status", async () => {
    const dest = join(tmpPath, "model.gguf.part");
    const fakeFetch = async () => new Response(null, { status: 404, statusText: "Not Found" });

    await expect(
      download("https://huggingface.co/example/missing", dest, fakeFetch),
    ).rejects.toThrow(/download failed/);
  });
});
