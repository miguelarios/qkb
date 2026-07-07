from __future__ import annotations

from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
from qkb.embed.fake import FakeProvider
from qkb.embed.ollama import OllamaProvider


def get_provider(cfg: Config) -> EmbeddingProvider:
    if cfg.embedding_provider == "ollama":
        return OllamaProvider(cfg.ollama_host, cfg.embedding_model, cfg.embedding_dim)
    if cfg.embedding_provider == "fake":
        return FakeProvider(cfg.embedding_dim)
    raise ValueError(f"unknown embedding provider: {cfg.embedding_provider!r}")
