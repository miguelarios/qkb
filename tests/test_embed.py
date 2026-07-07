from qkb.config import Config
from qkb.embed import get_provider
from qkb.embed.fake import FakeProvider
from qkb.embed.ollama import OllamaProvider


def test_get_provider_fake():
    cfg = Config(embedding_provider="fake", embedding_dim=8)
    provider = get_provider(cfg)
    assert isinstance(provider, FakeProvider)
    assert provider.dimension == 8


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
