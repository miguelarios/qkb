import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/embed/openai.js";

// Real OpenAI-compatible endpoint roundtrip. Needs QKB_OPENAI_API_KEY (and
// optionally QKB_OPENAI_BASE_URL for a compatible server); skips cleanly
// unless QKB_TEST_OPENAI=1.
const enabled = process.env.QKB_TEST_OPENAI === "1";

describe.skipIf(!enabled)("embed/openai integration (real server)", () => {
  it("embeds against a real OpenAI-compatible endpoint", async () => {
    const baseUrl = process.env.QKB_OPENAI_BASE_URL ?? "https://api.openai.com";
    const apiKey = process.env.QKB_OPENAI_API_KEY ?? null;
    const p = new OpenAIProvider(baseUrl, apiKey, "text-embedding-3-small", 1536);
    const vecs = await p.embed(["hello world"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(1536);
  });
});
