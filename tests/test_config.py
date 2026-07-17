from pathlib import Path

from qkb.config import load_config


def test_defaults():
    cfg = load_config(config_path=Path("/nonexistent/qkb.toml"), env={})
    assert cfg.vault_name == "Notes"
    assert cfg.embedding_model == "embeddinggemma"
    assert cfg.embedding_dim == 768
    assert cfg.fts_weights == [5.0, 3.0, 2.0, 1.0, 0.5]
    assert cfg.frontmatter["created"] == ["created", "date created"]
    assert cfg.frontmatter["id"] == ["id"]


def test_toml_overrides_and_alias_normalization(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text(
        """
[vault]
path = "/somewhere/vault"
name = "MyVault"

[embedding]
model = "nomic-embed-text"

[frontmatter]
context = "category"
created = ["birth", "created"]
"""
    )
    cfg = load_config(config_path=f, env={})
    assert cfg.vault_path == Path("/somewhere/vault")
    assert cfg.vault_name == "MyVault"
    assert cfg.embedding_model == "nomic-embed-text"
    assert cfg.frontmatter["context"] == ["category"]  # str -> [str]
    assert cfg.frontmatter["created"] == ["birth", "created"]
    assert cfg.frontmatter["id"] == ["id"]  # unmentioned keys keep defaults


def test_env_wins_over_toml(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text('[vault]\nname = "FromToml"\n')
    cfg = load_config(config_path=f, env={"QKB_VAULT_NAME": "FromEnv", "QKB_EMBEDDING_DIM": "512"})
    assert cfg.vault_name == "FromEnv"
    assert cfg.embedding_dim == 512


def test_embedding_templates_default_none():
    cfg = load_config(config_path=Path("/nonexistent/qkb.toml"), env={})
    assert cfg.embedding_doc_template is None
    assert cfg.embedding_query_template is None


def test_embedding_templates_from_toml(tmp_path):
    f = tmp_path / "config.toml"
    f.write_text(
        """
[embedding]
doc_template = "passage: {t}"
query_template = "query: {t}"
"""
    )
    cfg = load_config(config_path=f, env={})
    assert cfg.embedding_doc_template == "passage: {t}"
    assert cfg.embedding_query_template == "query: {t}"


def test_embedding_templates_env_override(tmp_path):
    cfg = load_config(
        config_path=Path("/nonexistent/qkb.toml"),
        env={
            "QKB_EMBEDDING_DOC_TEMPLATE": "doc: {t}",
            "QKB_EMBEDDING_QUERY_TEMPLATE": "query: {t}",
        },
    )
    assert cfg.embedding_doc_template == "doc: {t}"
    assert cfg.embedding_query_template == "query: {t}"


def test_dead_api_base_and_api_key_fields_removed():
    """8c: api_base/api_key were read by nothing (no provider used them); they
    were removed from Config along with their TOML/env mappings."""
    cfg = load_config(config_path=Path("/nonexistent/qkb.toml"), env={})
    assert not hasattr(cfg, "api_base")
    assert not hasattr(cfg, "api_key")


def test_local_provider_defaults():
    cfg = load_config(config_path=Path("/nonexistent"), env={})
    assert cfg.local_gguf_repo == "ggml-org/embeddinggemma-300M-GGUF"
    assert cfg.local_gguf_file == "embeddinggemma-300M-Q8_0.gguf"
    assert cfg.model_cache_dir == Path.home() / ".cache/qkb/models"


def test_local_provider_toml_overrides(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text(
        "[embedding]\n"
        'provider = "local"\n'
        'local_gguf_repo = "example-org/other-model-GGUF"\n'
        'local_gguf_file = "other-model-Q4_K_M.gguf"\n'
        'model_cache_dir = "/tmp/qkb-models"\n'
    )
    cfg = load_config(config_path=p, env={})
    assert cfg.embedding_provider == "local"
    assert cfg.local_gguf_repo == "example-org/other-model-GGUF"
    assert cfg.local_gguf_file == "other-model-Q4_K_M.gguf"
    assert cfg.model_cache_dir == Path("/tmp/qkb-models")


def test_local_provider_env_overrides(tmp_path):
    cfg = load_config(
        config_path=Path("/nonexistent"),
        env={
            "QKB_LOCAL_GGUF_REPO": "example-org/env-model-GGUF",
            "QKB_LOCAL_GGUF_FILE": "env-model.gguf",
            "QKB_MODEL_CACHE_DIR": "~/custom-cache",
        },
    )
    assert cfg.local_gguf_repo == "example-org/env-model-GGUF"
    assert cfg.local_gguf_file == "env-model.gguf"
    assert cfg.model_cache_dir == Path.home() / "custom-cache"
