import { describe, expect, it } from "vitest";
import { OllamaProvider } from "../../src/embed/ollama.js";

// Ports legacy/python/tests/test_ollama_provider.py (minus
// test_close_closes_underlying_client, which doesn't apply: this provider
// uses the global fetch per-request rather than holding a persistent
// keep-alive client to close). Offline: fetch is injected at construction.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embed/ollama", () => {
  it("formats doc and query prompts and posts them to /api/embed", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = JSON.parse(init?.body as string);
      seen.push({ url: String(url), body });
      const n = body.input.length;
      return jsonResponse({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3, 0.4]) });
    };
    const p = new OllamaProvider("http://testserver", "embeddinggemma", 4, { fetchImpl });

    await p.embed(["some doc"]);
    expect(seen[0]?.url).toBe("http://testserver/api/embed");
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

  it("lets explicit templates override the heuristic for a custom model tag", async () => {
    const seen: { body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      seen.push({ body });
      return jsonResponse({ embeddings: [[0.1, 0.2, 0.3, 0.4]] });
    };
    const p = new OllamaProvider("http://testserver", "hf.co/some/custom-GGUF", 4, {
      fetchImpl,
      docTemplate: "passage: {t}",
      queryTemplate: "query: {t}",
    });

    await p.embed(["some doc"]);
    expect(seen[0]?.body).toEqual({
      model: "hf.co/some/custom-GGUF",
      input: ["passage: some doc"],
    });

    await p.embedQuery("find me");
    expect(seen[1]?.body).toEqual({ model: "hf.co/some/custom-GGUF", input: ["query: find me"] });
  });

  it("falls back to the per-model heuristic when templates are unset", () => {
    const p = new OllamaProvider("http://testserver", "nomic-embed-text", 4);
    expect(p.docFormat).toBe("search_document: {t}");
    expect(p.queryFormat).toBe("search_query: {t}");
  });

  it("rejects a doc_template missing the {t} placeholder at construction", () => {
    expect(
      () =>
        new OllamaProvider("http://testserver", "embeddinggemma", 4, {
          docTemplate: "no placeholder",
        }),
    ).toThrow(/\{t\}/);
  });

  it("names the offending setting when a foreign named field is used", () => {
    expect(
      () =>
        new OllamaProvider("http://testserver", "embeddinggemma", 4, {
          docTemplate: "foo: {t} | {context}",
        }),
    ).toThrow(/doc_template/);
  });

  it("rejects a positional field in query_template", () => {
    expect(
      () =>
        new OllamaProvider("http://testserver", "embeddinggemma", 4, { queryTemplate: "{t} {0}" }),
    ).toThrow(/query_template/);
  });

  it("rejects an unbalanced brace in doc_template", () => {
    expect(
      () => new OllamaProvider("http://testserver", "embeddinggemma", 4, { docTemplate: "{t} {" }),
    ).toThrow(/doc_template/);
  });

  it("accepts a valid template with only the {t} placeholder", () => {
    const p = new OllamaProvider("http://testserver", "embeddinggemma", 4, {
      docTemplate: "search_query: {t}",
    });
    expect(p.docFormat).toBe("search_query: {t}");
  });

  it("raises on a dimension mismatch", async () => {
    const fetchImpl = async () => jsonResponse({ embeddings: [[0.1, 0.2]] });
    const p = new OllamaProvider("http://testserver", "embeddinggemma", 4, { fetchImpl });
    await expect(p.embed(["doc"])).rejects.toThrow(/dimension/);
  });

  it("batches inputs in groups of 32", async () => {
    const batchSizes: number[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      batchSizes.push(body.input.length);
      return jsonResponse({
        embeddings: Array.from({ length: body.input.length }, () => [0.1, 0.2, 0.3, 0.4]),
      });
    };
    const p = new OllamaProvider("http://testserver", "embeddinggemma", 4, { fetchImpl });
    const texts = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
    const vecs = await p.embed(texts);
    expect(batchSizes).toEqual([32, 8]);
    expect(vecs).toHaveLength(40);
  });

  it("raises an actionable error when the request fails", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const p = new OllamaProvider("http://testserver", "embeddinggemma", 4, { fetchImpl });
    await expect(p.embed(["doc"])).rejects.toThrow(/Ollama embed failed/);
  });
});
