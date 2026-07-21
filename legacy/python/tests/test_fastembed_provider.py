"""Unit tests for FastEmbedProvider with an injected fake embedder — no
onnxruntime, no downloads (mirrors test_local_provider.py's approach)."""

import pytest

from qkb.embed.fastembed import _CUSTOM_MODELS, FastEmbedProvider, _register_custom

GEMMA = "onnx-community/embeddinggemma-300m-ONNX"


class RecordingEmbedder:
    def __init__(self, dim=768):
        self.dim = dim
        self.calls: list[list[str]] = []

    def embed(self, inputs):
        self.calls.append(list(inputs))
        return [[0.1] * self.dim for _ in inputs]


def test_embed_applies_gemma_doc_template():
    fake = RecordingEmbedder()
    p = FastEmbedProvider(GEMMA, 768, embedder=fake)
    p.embed(["alpha", "beta"])
    assert fake.calls == [["title: none | text: alpha", "title: none | text: beta"]]


def test_embed_query_applies_gemma_query_template():
    fake = RecordingEmbedder()
    p = FastEmbedProvider(GEMMA, 768, embedder=fake)
    p.embed_query("find me")
    assert fake.calls == [["task: search result | query: find me"]]


def test_unknown_model_uses_passthrough_templates():
    fake = RecordingEmbedder()
    p = FastEmbedProvider("some-org/some-model", 768, embedder=fake)
    p.embed(["alpha"])
    p.embed_query("beta")
    assert fake.calls == [["alpha"], ["beta"]]


def test_explicit_templates_override_defaults():
    fake = RecordingEmbedder()
    p = FastEmbedProvider(
        GEMMA, 768, doc_template="passage: {t}", query_template="query: {t}", embedder=fake
    )
    p.embed(["a"])
    p.embed_query("b")
    assert fake.calls == [["passage: a"], ["query: b"]]


def test_empty_batch_short_circuits_without_touching_embedder():
    p = FastEmbedProvider(GEMMA, 768, embedder=None)  # lazy: never built
    assert p.embed([]) == []
    assert p._embedder is None


def test_dimension_mismatch_raises():
    fake = RecordingEmbedder(dim=384)
    p = FastEmbedProvider(GEMMA, 768, embedder=fake)
    with pytest.raises(RuntimeError, match="dimension 384"):
        p.embed(["alpha"])


def test_model_name_is_the_hf_id():
    p = FastEmbedProvider(GEMMA, 768, embedder=RecordingEmbedder())
    assert p.model_name == GEMMA
    assert p.dimension == 768


def test_default_model_is_registered_as_custom():
    # The shipped default must have a custom-model spec (it's not in
    # fastembed's built-in catalog) with the external-data file listed.
    spec = _CUSTOM_MODELS[GEMMA]
    assert spec["dim"] == 768
    assert spec["additional_files"] == [spec["model_file"] + "_data"]


def test_register_custom_is_noop_for_unknown_models():
    # Must not import fastembed or blow up for models fastembed already knows.
    _register_custom("sentence-transformers/all-MiniLM-L6-v2")
