"""Layered configuration: defaults -> TOML file -> QKB_* env vars."""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG_PATH = Path.home() / ".config" / "qkb" / "config.toml"

DEFAULT_FRONTMATTER: dict[str, list[str]] = {
    "id": ["id"],
    "type": ["type"],
    "title": ["title"],
    "context": ["context"],
    "source": ["source"],
    "date": ["date"],
    "created": ["created", "date created"],
    "tags": ["tags"],
}


@dataclass
class Config:
    vault_path: Path = Path.home() / "Notes"
    vault_name: str = "Notes"
    db_path: Path = Path.home() / ".local/share/qkb/qkb.db"
    embedding_provider: str = "ollama"
    embedding_model: str = "embeddinggemma"
    embedding_dim: int = 768
    ollama_host: str = "http://localhost:11434"
    embedding_doc_template: str | None = None
    embedding_query_template: str | None = None
    local_gguf_repo: str = "ggml-org/embeddinggemma-300M-GGUF"
    local_gguf_file: str = "embeddinggemma-300M-Q8_0.gguf"
    model_cache_dir: Path = Path.home() / ".cache/qkb/models"
    chunk_target_tokens: int = 500
    chunk_overlap_percent: int = 15
    default_limit: int = 10
    rrf_k: int = 60
    vec_candidates: int = 30
    fts_candidates: int = 30
    fts_weights: list[float] = field(default_factory=lambda: [5.0, 3.0, 2.0, 1.0, 0.5])
    frontmatter: dict[str, list[str]] = field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_FRONTMATTER.items()}
    )


# (toml_section, toml_key, Config attr, caster)
_TOML_MAP = [
    ("vault", "path", "vault_path", Path),
    ("vault", "name", "vault_name", str),
    ("database", "path", "db_path", Path),
    ("embedding", "provider", "embedding_provider", str),
    ("embedding", "model", "embedding_model", str),
    ("embedding", "dimension", "embedding_dim", int),
    ("embedding", "ollama_host", "ollama_host", str),
    ("embedding", "doc_template", "embedding_doc_template", str),
    ("embedding", "query_template", "embedding_query_template", str),
    ("embedding", "local_gguf_repo", "local_gguf_repo", str),
    ("embedding", "local_gguf_file", "local_gguf_file", str),
    ("embedding", "model_cache_dir", "model_cache_dir", Path),
    ("chunking", "target_tokens", "chunk_target_tokens", int),
    ("chunking", "overlap_percent", "chunk_overlap_percent", int),
    ("search", "default_limit", "default_limit", int),
    ("search", "rrf_k", "rrf_k", int),
    ("search", "vec_candidates", "vec_candidates", int),
    ("search", "fts_candidates", "fts_candidates", int),
    ("search", "fts_weights", "fts_weights", list),
]

# QKB_<NAME> env var -> Config attr
_ENV_MAP = {
    "QKB_VAULT_PATH": ("vault_path", Path),
    "QKB_VAULT_NAME": ("vault_name", str),
    "QKB_DB_PATH": ("db_path", Path),
    "QKB_EMBEDDING_PROVIDER": ("embedding_provider", str),
    "QKB_EMBEDDING_MODEL": ("embedding_model", str),
    "QKB_EMBEDDING_DIM": ("embedding_dim", int),
    "QKB_OLLAMA_HOST": ("ollama_host", str),
    "QKB_EMBEDDING_DOC_TEMPLATE": ("embedding_doc_template", str),
    "QKB_EMBEDDING_QUERY_TEMPLATE": ("embedding_query_template", str),
    "QKB_LOCAL_GGUF_REPO": ("local_gguf_repo", str),
    "QKB_LOCAL_GGUF_FILE": ("local_gguf_file", str),
    "QKB_MODEL_CACHE_DIR": ("model_cache_dir", Path),
}


def load_config(config_path: Path | None = None, env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    path = config_path or Path(env.get("QKB_CONFIG", DEFAULT_CONFIG_PATH))
    cfg = Config()

    if path.is_file():
        data = tomllib.loads(path.read_text())
        for section, key, attr, cast in _TOML_MAP:
            if key in data.get(section, {}):
                setattr(cfg, attr, cast(data[section][key]))
        for canonical, aliases in data.get("frontmatter", {}).items():
            if canonical in cfg.frontmatter:
                cfg.frontmatter[canonical] = (
                    [aliases] if isinstance(aliases, str) else list(aliases)
                )

    for var, (attr, cast) in _ENV_MAP.items():
        if var in env:
            setattr(cfg, attr, cast(env[var]))

    cfg.vault_path = cfg.vault_path.expanduser()
    cfg.db_path = cfg.db_path.expanduser()
    cfg.model_cache_dir = cfg.model_cache_dir.expanduser()
    return cfg
