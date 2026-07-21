"""In-process embeddings via fastembed (ONNX Runtime).

The default provider (`provider = "local"`). No resident service and no
local compile: fastembed and onnxruntime ship prebuilt wheels on PyPI, so
`uv tool install qkb-search` just works — the C/C++ work is done upfront by
the wheel builders, the same way QMD relies on node-llama-cpp's prebuilt
native binaries. The ONNX model is downloaded once on first use and cached
by fastembed.

The default model is the ONNX export of embeddinggemma-300M — the same
embedding model QMD uses (QMD downloads the GGUF packaging for llama.cpp;
we download the ONNX packaging for onnxruntime; same weights either way).
It is not in fastembed's built-in catalog, so it is registered here as a
custom model (_CUSTOM_MODELS) before first load.
"""

from __future__ import annotations

from typing import Any

from qkb.embed.templates import default_formats, validated_template

# Models outside fastembed's built-in catalog, registered on demand via
# TextEmbedding.add_custom_model(). Values are plain data so importing this
# module never imports fastembed/onnxruntime (keeps `qkb status` and provider
# dispatch instant).
_CUSTOM_MODELS: dict[str, dict[str, Any]] = {
    "onnx-community/embeddinggemma-300m-ONNX": {
        # q8 quantization (~310 MB) — same size class as the Q8_0 GGUF QMD
        # pulls. The .onnx file stores weights in an external _data file,
        # which must be listed or the download is incomplete.
        "model_file": "onnx/model_quantized.onnx",
        "additional_files": ["onnx/model_quantized.onnx_data"],
        "dim": 768,
    },
}

_registered: set[str] = set()


def _register_custom(model: str) -> None:
    spec = _CUSTOM_MODELS.get(model)
    if spec is None or model in _registered:
        return
    from fastembed import TextEmbedding
    from fastembed.common.model_description import ModelSource, PoolingType

    TextEmbedding.add_custom_model(
        model=model,
        pooling=PoolingType.MEAN,
        normalization=True,
        sources=ModelSource(hf=model),
        dim=spec["dim"],
        model_file=spec["model_file"],
        additional_files=spec["additional_files"],
    )
    _registered.add(model)


class FastEmbedProvider:
    def __init__(
        self,
        model: str,
        dimension: int,
        doc_template: str | None = None,
        query_template: str | None = None,
        embedder: Any | None = None,
    ):
        """`embedder` is injectable for tests. When None the fastembed
        TextEmbedding is built lazily on first embed — so constructing the
        provider (for `qkb status`, provider dispatch, `--help`) neither
        imports onnxruntime nor downloads the model until an embedding is
        actually needed."""
        self._model = model
        self._dim = dimension
        # Template lookup keys off the repo basename so an HF id like
        # "onnx-community/embeddinggemma-300m-ONNX" hits the embeddinggemma
        # prompt formats shared with the ollama/gguf providers.
        family = model.rsplit("/", 1)[-1]
        default_doc_fmt, default_query_fmt = default_formats(family)
        self._doc_fmt = validated_template("doc_template", doc_template) or default_doc_fmt
        self._query_fmt = validated_template("query_template", query_template) or default_query_fmt
        self._embedder = embedder

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        # The HF model id. Distinct per model, so check_embedding_config
        # forces a --full re-embed whenever the configured model changes —
        # vectors across models and dimensions are not interchangeable.
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
            _register_custom(self._model)
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
        return self._embed_raw([self._doc_fmt.format(t=t) for t in texts])

    def embed_query(self, query: str) -> list[float]:
        return self._embed_raw([self._query_fmt.format(t=query)])[0]
