import { describe, expect, it } from "vitest";
import { defaultFormats, validatedTemplate } from "../../src/embed/templates.js";

// Ports legacy/python/tests/test_embed_templates.py.
describe("embed/templates", () => {
  it("returns embeddinggemma formats", () => {
    const [doc, query] = defaultFormats("embeddinggemma");
    expect(doc).toBe("title: none | text: {t}");
    expect(query).toBe("task: search result | query: {t}");
  });

  it("recognizes embeddinggemma GGUF stems via the startsWith heuristic", () => {
    // The llama provider derives model names from GGUF file stems; the
    // startsWith() heuristic must still recognize them.
    const [doc, query] = defaultFormats("embeddinggemma-300M-Q8_0");
    expect(doc).toBe("title: none | text: {t}");
    expect(query).toBe("task: search result | query: {t}");
  });

  it("returns nomic formats", () => {
    expect(defaultFormats("nomic-embed-text")).toEqual([
      "search_document: {t}",
      "search_query: {t}",
    ]);
  });

  it("passes unknown models through unchanged", () => {
    expect(defaultFormats("mystery-model")).toEqual(["{t}", "{t}"]);
  });

  it("accepts a valid template", () => {
    expect(validatedTemplate("doc_template", "prefix: {t}")).toBe("prefix: {t}");
  });

  it("passes null through unchanged", () => {
    expect(validatedTemplate("doc_template", null)).toBeNull();
  });

  it("rejects a template missing the {t} placeholder", () => {
    expect(() => validatedTemplate("doc_template", "no placeholder here")).toThrow(/doc_template/);
  });

  it("rejects a template with a foreign named field", () => {
    expect(() => validatedTemplate("query_template", "{t} | {context}")).toThrow(/query_template/);
  });

  it("rejects a template with a positional field", () => {
    expect(() => validatedTemplate("query_template", "{t} {0}")).toThrow(/query_template/);
  });

  it("rejects a template with an unbalanced brace", () => {
    expect(() => validatedTemplate("doc_template", "{t} {")).toThrow(/doc_template/);
  });
});
