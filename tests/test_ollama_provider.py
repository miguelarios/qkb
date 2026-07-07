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


def test_explicit_templates_override_heuristic():
    """8e: explicit doc/query templates must win over the per-model _formats()
    heuristic, so a custom model tag (e.g. hf.co/...GGUF) isn't stuck skipping
    the trained task prefix with no way to override."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content))
        n = len(seen["input"])
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3, 0.4]] * n})

    p = OllamaProvider(
        host="http://testserver",
        model="hf.co/some/custom-GGUF",
        dimension=4,
        doc_template="passage: {t}",
        query_template="query: {t}",
    )
    p._client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://testserver")
    p.embed(["some doc"])
    assert seen["input"] == ["passage: some doc"]
    p.embed_query("find me")
    assert seen["input"] == ["query: find me"]


def test_unset_templates_fall_back_to_heuristic():
    p = OllamaProvider(host="http://testserver", model="nomic-embed-text", dimension=4)
    assert p._doc_fmt == "search_document: {t}"
    assert p._query_fmt == "search_query: {t}"


def test_template_missing_placeholder_raises():
    with pytest.raises(ValueError, match=r"\{t\}"):
        OllamaProvider(
            host="http://testserver",
            model="embeddinggemma",
            dimension=4,
            doc_template="no placeholder here",
        )


def test_dimension_mismatch_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2]]})

    p = make_provider(handler)
    with pytest.raises(RuntimeError, match="dimension"):
        p.embed(["doc"])


def test_close_closes_underlying_client():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": []})

    p = make_provider(handler)
    assert p._client.is_closed is False
    p.close()
    assert p._client.is_closed is True


@pytest.mark.integration
def test_real_ollama_roundtrip():
    p = OllamaProvider(host="http://localhost:11434", model="embeddinggemma", dimension=768)
    vecs = p.embed(["hello world"])
    assert len(vecs) == 1 and len(vecs[0]) == 768
