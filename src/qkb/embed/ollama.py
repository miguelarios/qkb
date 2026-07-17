"""Local embeddings via the Ollama HTTP API (/api/embed)."""

from __future__ import annotations

import httpx

from qkb.embed.templates import default_formats, validated_template

_BATCH = 32


class OllamaProvider:
    def __init__(
        self,
        host: str,
        model: str,
        dimension: int,
        doc_template: str | None = None,
        query_template: str | None = None,
    ):
        """`doc_template`/`query_template` are explicit `{t}`-placeholder prompt
        templates (e.g. from [embedding] doc_template/query_template config).
        When either is unset, the per-model `_formats(model)` heuristic is used
        for that slot — so a custom model tag (that the heuristic doesn't
        recognize) can still get correct task-prefixed prompts via config."""
        self._model = model
        self._dim = dimension
        default_doc_fmt, default_query_fmt = default_formats(model)
        self._doc_fmt = validated_template("doc_template", doc_template) or default_doc_fmt
        self._query_fmt = validated_template("query_template", query_template) or default_query_fmt
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

    def close(self) -> None:
        """Close the underlying httpx.Client (review finding 9: MCP built a
        fresh OllamaProvider — and thus a fresh keep-alive httpx.Client —
        per tool call and never closed it)."""
        self._client.close()
