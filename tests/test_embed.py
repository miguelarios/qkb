import sys
import types

import pytest

from qkb.config import Config
from qkb.embed import get_provider
from qkb.embed.fake import FakeProvider
from qkb.embed.local import LlamaCppProvider
from qkb.embed.ollama import OllamaProvider


def test_get_provider_fake():
    cfg = Config(embedding_provider="fake", embedding_dim=8)
    provider = get_provider(cfg)
    assert isinstance(provider, FakeProvider)
    assert provider.dimension == 8


def test_get_provider_unknown_raises():
    cfg = Config(embedding_provider="mystery")
    with pytest.raises(ValueError, match="mystery"):
        get_provider(cfg)


def test_get_provider_local_dispatch(monkeypatch, tmp_path):
    """The 'local' branch is tested with a fake llama_cpp module injected
    into sys.modules -- no llama-cpp-python needed."""
    constructed: list[dict] = []

    class FakeLlama:
        def __init__(self, **kwargs):
            constructed.append(kwargs)

        def embed(self, inputs):
            return [[0.0] * 768 for _ in inputs]

    monkeypatch.setitem(sys.modules, "llama_cpp", types.SimpleNamespace(Llama=FakeLlama))

    cfg = Config(embedding_provider="local", model_cache_dir=tmp_path)
    # pre-cache the "model" so get_provider must not download anything
    (tmp_path / cfg.local_gguf_file).write_bytes(b"GGUF")

    provider = get_provider(cfg)

    assert isinstance(provider, LlamaCppProvider)
    assert provider.model_name == "embeddinggemma-300M-Q8_0"
    assert constructed[0]["model_path"] == str(tmp_path / cfg.local_gguf_file)
    assert constructed[0]["embedding"] is True


def test_get_provider_ollama_threads_explicit_templates():
    """8e: get_provider must pass Config's embedding_doc_template/query_template
    through to OllamaProvider so an explicit override actually takes effect."""
    cfg = Config(
        embedding_provider="ollama",
        embedding_model="hf.co/some/custom-GGUF",
        embedding_dim=4,
        embedding_doc_template="passage: {t}",
        embedding_query_template="query: {t}",
    )
    provider = get_provider(cfg)
    assert isinstance(provider, OllamaProvider)
    assert provider._doc_fmt == "passage: {t}"
    assert provider._query_fmt == "query: {t}"
    provider.close()


def test_get_provider_ollama_defaults_to_heuristic_when_unset():
    cfg = Config(embedding_provider="ollama", embedding_model="nomic-embed-text", embedding_dim=4)
    provider = get_provider(cfg)
    assert provider._doc_fmt == "search_document: {t}"
    assert provider._query_fmt == "search_query: {t}"
    provider.close()
