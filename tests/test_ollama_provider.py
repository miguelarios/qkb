import httpx
import pytest

from qkb.embed.ollama import OllamaProvider


def make_provider(handler) -> OllamaProvider:
    p = OllamaProvider(host="http://testserver", model="embeddinggemma", dimension=4)
    p._client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://testserver")
    return p


def test_document_and_query_prompt_formatting():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content))
        n = len(seen["input"])
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3, 0.4]] * n})

    p = make_provider(handler)
    p.embed(["some doc"])
    assert seen["input"] == ["title: none | text: some doc"]
    p.embed_query("find me")
    assert seen["input"] == ["task: search result | query: find me"]


def test_dimension_mismatch_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2]]})

    p = make_provider(handler)
    with pytest.raises(RuntimeError, match="dimension"):
        p.embed(["doc"])


@pytest.mark.integration
def test_real_ollama_roundtrip():
    p = OllamaProvider(host="http://localhost:11434", model="embeddinggemma", dimension=768)
    vecs = p.embed(["hello world"])
    assert len(vecs) == 1 and len(vecs[0]) == 768
