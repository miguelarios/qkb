import { describe, expect, it } from "vitest";
import { OllamaProvider } from "../../src/embed/ollama.js";

// Ports legacy/python/tests/test_ollama_provider.py's
// test_real_ollama_roundtrip. Needs a real Ollama server with
// embeddinggemma pulled; skips cleanly unless QKB_TEST_OLLAMA=1.
const enabled = process.env.QKB_TEST_OLLAMA === "1";

describe.skipIf(!enabled)("embed/ollama integration (real server)", () => {
  it("embeds against a real Ollama server", async () => {
    const p = new OllamaProvider("http://localhost:11434", "embeddinggemma", 768);
    const vecs = await p.embed(["hello world"]);
    expect(vecs).toHaveLength(1);
    expect(vecs[0]).toHaveLength(768);
  });
});
