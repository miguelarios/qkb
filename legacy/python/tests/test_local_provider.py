"""LlamaCppProvider unit tests. Fully offline: a recording fake stands in
for llama_cpp.Llama, so these pass without llama-cpp-python installed."""

import sys
from pathlib import Path

import pytest

from qkb.embed.base import EmbeddingProvider
from qkb.embed.local import LlamaCppProvider

DIM = 4
MODEL = Path("/models/embeddinggemma-300M-Q8_0.gguf")


class RecordingLlama:
    def __init__(self, dim: int = DIM):
        self.dim = dim
        self.calls: list[list[str]] = []
        self.closed = False

    def embed(self, inputs: list[str]) -> list[list[float]]:
        self.calls.append(list(inputs))
        return [[0.1] * self.dim for _ in inputs]

    def close(self) -> None:
        self.closed = True


def make_provider(**kwargs) -> tuple[LlamaCppProvider, RecordingLlama]:
    llama = RecordingLlama(dim=kwargs.pop("dim", DIM))
    p = LlamaCppProvider(MODEL, kwargs.pop("dimension", DIM), llama=llama, **kwargs)
    return p, llama


def test_satisfies_protocol():
    p, _ = make_provider()
    assert isinstance(p, EmbeddingProvider)


def test_model_name_is_gguf_stem():
    p, _ = make_provider()
    assert p.model_name == "embeddinggemma-300M-Q8_0"
    assert p.dimension == DIM


def test_embed_applies_embeddinggemma_doc_template():
    p, llama = make_provider()
    vecs = p.embed(["alpha", "beta"])
    assert llama.calls == [["title: none | text: alpha", "title: none | text: beta"]]
    assert vecs == [[0.1] * DIM, [0.1] * DIM]


def test_embed_query_applies_embeddinggemma_query_template():
    p, llama = make_provider()
    vec = p.embed_query("find things")
    assert llama.calls == [["task: search result | query: find things"]]
    assert vec == [0.1] * DIM


def test_explicit_templates_override_heuristic():
    p, llama = make_provider(doc_template="doc: {t}", query_template="q: {t}")
    p.embed(["x"])
    p.embed_query("y")
    assert llama.calls == [["doc: x"], ["q: y"]]


def test_invalid_template_rejected_at_construction():
    with pytest.raises(ValueError, match="doc_template"):
        LlamaCppProvider(MODEL, DIM, doc_template="no placeholder", llama=RecordingLlama())


def test_dimension_mismatch_raises():
    p, _ = make_provider(dim=DIM + 1)
    with pytest.raises(RuntimeError, match="dimension"):
        p.embed(["alpha"])


def test_empty_batch_returns_empty_without_calling_llama():
    p, llama = make_provider()
    assert p.embed([]) == []
    assert llama.calls == []


def test_close_closes_llama():
    p, llama = make_provider()
    p.close()
    assert llama.closed


def test_missing_llama_cpp_raises_actionable_error(monkeypatch, tmp_path):
    # sys.modules[name] = None makes `import llama_cpp` raise ImportError
    # even on machines where the package IS installed.
    monkeypatch.setitem(sys.modules, "llama_cpp", None)
    gguf = tmp_path / "m.gguf"
    gguf.write_bytes(b"GGUF")
    with pytest.raises(RuntimeError, match=r"qkb-search\[local\]"):
        LlamaCppProvider(gguf, DIM)
