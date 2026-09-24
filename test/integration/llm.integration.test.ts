import { describe, expect, it } from "vitest";
import { LlamaExpander } from "../../src/llm/expand.js";
import { LlamaReranker } from "../../src/llm/rerank.js";

// Real reranker / query-expansion models (#37, #38). Downloads the GGUFs
// (~640MB reranker, ~1.1GB expansion) to ~/.cache/qkb/models on first run.
// Never run in CI — only via `npm run test:integration` (QKB_INTEGRATION=1).
const CACHE = `${process.env.HOME}/.cache/qkb/models`;

describe("llm integration (real models)", () => {
  it("the reranker scores a relevant passage above an off-topic one", async () => {
    const r = new LlamaReranker(
      "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
      "qwen3-reranker-0.6b-q8_0.gguf",
      CACHE,
    );
    try {
      const [good, bad] = await r.rank("how do I renew a TLS certificate", [
        "Certificate renewal: run certbot renew, then reload the proxy.",
        "Grocery list: eggs, milk, bread.",
      ]);
      expect(good).toBeGreaterThan(bad as number);
      // Over-long passages are truncated, not rejected.
      const [long] = await r.rank("certificate", ["certificate ".repeat(5000)]);
      expect(long).toBeGreaterThanOrEqual(0);
    } finally {
      await r.close();
    }
  }, 300_000);

  it("the expander writes lex/vec variants that stay on topic", async () => {
    const e = new LlamaExpander(
      "tobil/qmd-query-expansion-1.7B-gguf",
      "qmd-query-expansion-1.7B-q4_k_m.gguf",
      CACHE,
      4,
    );
    try {
      const variants = await e.expand("traefik certificate renewal");
      expect(variants.length).toBeGreaterThan(0);
      for (const v of variants) expect(["lex", "vec"]).toContain(v.type);
    } finally {
      await e.close();
    }
  }, 600_000);
});
