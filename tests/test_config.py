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


def test_dead_api_base_and_api_key_fields_removed():
    """8c: api_base/api_key were read by nothing (no provider used them); they
    were removed from Config along with their TOML/env mappings."""
    cfg = load_config(config_path=Path("/nonexistent/qkb.toml"), env={})
    assert not hasattr(cfg, "api_base")
    assert not hasattr(cfg, "api_key")
