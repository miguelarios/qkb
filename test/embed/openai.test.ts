import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/embed/openai.js";

// New module (no Python original): mirrors embed/ollama.ts's structure,
// dimension-check, and error style, per the task brief. Talks to
// OpenAI-compatible `/v1/embeddings` endpoints (OpenAI itself, LM Studio,
// llamafile, vLLM). Offline: fetch is injected at construction.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embed/openai", () => {
  it("posts to {baseUrl}/v1/embeddings with an Authorization bearer header", async () => {
    const seen: { url: string; headers: Headers; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = JSON.parse(init?.body as string);
      seen.push({ url: String(url), headers: new Headers(init?.headers), body });
      return jsonResponse({
        data: body.input.map((_: string, i: number) => ({
          embedding: [0.1, 0.2, 0.3, 0.4],
          index: i,
        })),
      });
    };
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "text-embedding-3-small", 4, {
      fetchImpl,
    });

    await p.embed(["some doc"]);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(seen[0]?.body).toEqual({ model: "text-embedding-3-small", input: ["some doc"] });
  });

  it("applies doc/query templates the same way ollama does", async () => {
    const seen: { body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      seen.push({ body });
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] });
    };
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4, {
      fetchImpl,
    });

    await p.embed(["some doc"]);
    expect(seen[0]?.body).toEqual({
      model: "embeddinggemma",
      input: ["title: none | text: some doc"],
    });

    await p.embedQuery("find me");
    expect(seen[1]?.body).toEqual({
      model: "embeddinggemma",
      input: ["task: search result | query: find me"],
    });
  });

  it("omits the Authorization header when no api key is configured", async () => {
    const seen: { headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push({ headers: new Headers(init?.headers) });
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] });
    };
    const p = new OpenAIProvider("http://localhost:1234", null, "local-model", 4, { fetchImpl });
    await p.embed(["doc"]);
    expect(seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("rejects an invalid template at construction", () => {
    expect(
      () =>
        new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4, {
          docTemplate: "no placeholder",
        }),
    ).toThrow(/doc_template/);
  });

  it("raises on a dimension mismatch", async () => {
    const fetchImpl = async () => jsonResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4, {
      fetchImpl,
    });
    await expect(p.embed(["doc"])).rejects.toThrow(/dimension/);
  });

  it("batches inputs in groups of 32", async () => {
    const batchSizes: number[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      batchSizes.push(body.input.length);
      return jsonResponse({
        data: body.input.map((_: string, i: number) => ({
          embedding: [0.1, 0.2, 0.3, 0.4],
          index: i,
        })),
      });
    };
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4, {
      fetchImpl,
    });
    const texts = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
    const vecs = await p.embed(texts);
    expect(batchSizes).toEqual([32, 8]);
    expect(vecs).toHaveLength(40);
  });

  it("raises an actionable error when the request fails", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4, {
      fetchImpl,
    });
    await expect(p.embed(["doc"])).rejects.toThrow(/OpenAI embed failed/);
  });

  it("reports modelName and dimension", () => {
    const p = new OpenAIProvider("https://api.openai.com", "sk-test", "embeddinggemma", 4);
    expect(p.modelName).toBe("embeddinggemma");
    expect(p.dimension).toBe(4);
  });
});
