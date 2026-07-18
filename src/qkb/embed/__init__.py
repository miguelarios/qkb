from __future__ import annotations

from qkb.config import Config
from qkb.embed.base import EmbeddingProvider
from qkb.embed.fake import FakeProvider
from qkb.embed.ollama import OllamaProvider


def get_provider(cfg: Config) -> EmbeddingProvider:
    # Default: in-process ONNX embeddings via fastembed. Ships prebuilt
    # wheels, so `uv tool install qkb-search` needs no service and no compile.
    if cfg.embedding_provider in ("local", "fastembed"):
        from qkb.embed.fastembed import FastEmbedProvider

        return FastEmbedProvider(
            cfg.embedding_model,
            cfg.embedding_dim,
            doc_template=cfg.embedding_doc_template,
            query_template=cfg.embedding_query_template,
        )
    if cfg.embedding_provider == "ollama":
        return OllamaProvider(
            cfg.ollama_host,
            cfg.embedding_model,
            cfg.embedding_dim,
            doc_template=cfg.embedding_doc_template,
            query_template=cfg.embedding_query_template,
        )
    # Optional in-process GGUF backend (llama-cpp-python, the `[gguf]` extra).
    if cfg.embedding_provider == "gguf":
        from qkb.embed.local import LlamaCppProvider
        from qkb.embed.models import ensure_model

        model_path = ensure_model(cfg.local_gguf_repo, cfg.local_gguf_file, cfg.model_cache_dir)
        return LlamaCppProvider(
            model_path,
            cfg.embedding_dim,
            doc_template=cfg.embedding_doc_template,
            query_template=cfg.embedding_query_template,
        )
    if cfg.embedding_provider == "fake":
        return FakeProvider(cfg.embedding_dim)
    raise ValueError(f"unknown embedding provider: {cfg.embedding_provider!r}")
