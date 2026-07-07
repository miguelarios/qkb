"""Local embeddings via the Ollama HTTP API (/api/embed)."""

from __future__ import annotations

import httpx

_BATCH = 32


def _formats(model: str) -> tuple[str, str]:
    """(doc_template, query_template) with {t} placeholder."""
    if model.startswith("embeddinggemma"):
        return "title: none | text: {t}", "task: search result | query: {t}"
    if model.startswith("nomic"):
        return "search_document: {t}", "search_query: {t}"
    return "{t}", "{t}"


class OllamaProvider:
    def __init__(self, host: str, model: str, dimension: int):
        self._model = model
        self._dim = dimension
        self._doc_fmt, self._query_fmt = _formats(model)
        self._client = httpx.Client(base_url=host, timeout=120.0)

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return self._model

    def _embed_raw(self, inputs: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(inputs), _BATCH):
            batch = inputs[i : i + _BATCH]
            try:
                resp = self._client.post("/api/embed", json={"model": self._model, "input": batch})
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise RuntimeError(
                    f"Ollama embed failed ({e}). Is Ollama running and is "
                    f"'{self._model}' pulled? (ollama pull {self._model})"
                ) from e
            vectors = resp.json()["embeddings"]
            for v in vectors:
                if len(v) != self._dim:
                    raise RuntimeError(
                        f"Model '{self._model}' returned dimension {len(v)}, "
                        f"config says {self._dim}. Fix [embedding].dimension."
                    )
            out.extend(vectors)
        return out

    def embed(self, texts: list[str]) -> list[list[float]]:
        return self._embed_raw([self._doc_fmt.format(t=t) for t in texts])

    def embed_query(self, query: str) -> list[float]:
        return self._embed_raw([self._query_fmt.format(t=query)])[0]
