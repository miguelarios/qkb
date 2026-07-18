"""In-process embeddings via fastembed (ONNX Runtime).

The default provider (`provider = "local"`). No resident service and no
local compile: fastembed and onnxruntime ship prebuilt wheels on PyPI, so
`uv tool install qkb-search` just works — the C/C++ work is done upfront by
the wheel builders, the same way QMD relies on node-llama-cpp's prebuilt
native binaries. The ONNX model is downloaded once on first use and cached
by fastembed (under ~/.cache/huggingface, or FASTEMBED_CACHE_PATH).
"""

from __future__ import annotations

from typing import Any


class FastEmbedProvider:
    def __init__(
        self,
        model: str,
        dimension: int,
        embedder: Any | None = None,
    ):
        """`embedder` is injectable for tests. When None the fastembed
        TextEmbedding is built lazily on first embed — so constructing the
        provider (for `qkb status`, provider dispatch, `--help`) neither
        imports onnxruntime nor downloads the model until an embedding is
        actually needed."""
        self._model = model
        self._dim = dimension
        self._embedder = embedder

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        # The HF model id (e.g. ".../paraphrase-multilingual-MiniLM-L12-v2").
        # Distinct per model, so check_embedding_config forces a --full
        # re-embed whenever the configured model changes — vectors across
        # models and dimensions are not interchangeable.
        return self._model

    def _get(self) -> Any:
        if self._embedder is None:
            try:
                from fastembed import TextEmbedding
            except ImportError as e:  # pragma: no cover - fastembed is a core dep
                raise RuntimeError(
                    "embedding provider 'local' requires fastembed (a core "
                    "dependency). Reinstall qkb: pip install --upgrade qkb-search"
                ) from e
            self._embedder = TextEmbedding(model_name=self._model)
        return self._embedder

    def _embed_raw(self, inputs: list[str]) -> list[list[float]]:
        if not inputs:
            return []
        vectors: list[list[float]] = [list(map(float, v)) for v in self._get().embed(inputs)]
        for v in vectors:
            if len(v) != self._dim:
                raise RuntimeError(
                    f"Model '{self._model}' returned dimension {len(v)}, "
                    f"config says {self._dim}. Fix [embedding].dimension."
                )
        return vectors

    def embed(self, texts: list[str]) -> list[list[float]]:
        return self._embed_raw(texts)

    def embed_query(self, query: str) -> list[float]:
        # The default model (paraphrase-multilingual-MiniLM) is symmetric, so
        # query and document text use the same encoding. An asymmetric model
        # like e5 would want query:/passage: prefixes — add that if adopted.
        return self._embed_raw([query])[0]
