"""In-process embeddings via llama-cpp-python (GGUF models).

No resident service: the model lives in RAM only while a qkb process runs.
One-shot CLI calls pay a ~1s model load; the long-lived MCP server loads it
once. Requires the optional extra: pip install 'qkb-search[local]'.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from qkb.embed.templates import default_formats, validated_template

# embeddinggemma's context window; also comfortably fits chunk_target_tokens
# (500) plus template overhead for any supported model.
_N_CTX = 2048


class LlamaCppProvider:
    def __init__(
        self,
        model_path: Path,
        dimension: int,
        doc_template: str | None = None,
        query_template: str | None = None,
        llama: Any | None = None,
    ):
        """`llama` is injectable for tests; when None, llama_cpp is imported
        and the model loaded here (fail-fast on a missing extra or a bad
        GGUF, before any ingest work starts)."""
        # model_name is the GGUF stem (e.g. "embeddinggemma-300M-Q8_0"), NOT
        # the bare model family Ollama reports ("embeddinggemma"): vectors
        # from different runtimes/quantizations are not interchangeable, and
        # the differing name makes check_embedding_config force a --full
        # re-embed when a machine switches provider.
        self._model = model_path.stem
        self._dim = dimension
        default_doc_fmt, default_query_fmt = default_formats(self._model)
        self._doc_fmt = validated_template("doc_template", doc_template) or default_doc_fmt
        self._query_fmt = validated_template("query_template", query_template) or default_query_fmt
        if llama is None:
            try:
                from llama_cpp import Llama
            except ImportError as e:
                raise RuntimeError(
                    "embedding provider 'local' requires llama-cpp-python. "
                    "Install it with: pip install 'qkb-search[local]'"
                ) from e
            llama = Llama(model_path=str(model_path), embedding=True, n_ctx=_N_CTX, verbose=False)
        self._llama = llama

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return self._model

    def _embed_raw(self, inputs: list[str]) -> list[list[float]]:
        if not inputs:
            return []
        vectors: list[list[float]] = self._llama.embed(inputs)
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

    def close(self) -> None:
        """Free the model. The MCP server duck-types close() on shutdown."""
        close = getattr(self._llama, "close", None)
        if close is not None:
            close()
