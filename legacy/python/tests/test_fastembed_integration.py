"""Real fastembed / ONNX inference for the default `local` provider.
Downloads the ONNX model on first run — integration-only, never in CI."""

import pytest

pytest.importorskip("fastembed")

from qkb.config import Config  # noqa: E402
from qkb.embed import get_provider  # noqa: E402

pytestmark = pytest.mark.integration


def test_real_embed_roundtrip():
    cfg = Config()  # defaults: provider="local", embeddinggemma-300m ONNX, dim 768
    provider = get_provider(cfg)  # downloads the ONNX model on first run
    vecs = provider.embed(["the quick brown fox", "totally different topic: sqlite"])
    q = provider.embed_query("fast animal jumping")
    assert len(vecs) == 2
    assert all(len(v) == cfg.embedding_dim for v in vecs)
    assert len(q) == cfg.embedding_dim

    def dot(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    # the fox document must be nearer the fox query than the sqlite one
    assert dot(q, vecs[0]) > dot(q, vecs[1])
