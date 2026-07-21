"""Deterministic offline provider for tests and CI."""

from __future__ import annotations

import hashlib
import math
import struct


class FakeProvider:
    def __init__(self, dimension: int = 8):
        self._dim = dimension

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return f"fake-{self._dim}d"

    def _vector(self, text: str) -> list[float]:
        raw = b""
        counter = 0
        while len(raw) < self._dim * 4:
            raw += hashlib.sha256(f"{counter}:{text}".encode()).digest()
            counter += 1
        vals = [struct.unpack_from(">i", raw, i * 4)[0] for i in range(self._dim)]
        norm = math.sqrt(sum(v * v for v in vals)) or 1.0
        return [v / norm for v in vals]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]

    def embed_query(self, query: str) -> list[float]:
        return self._vector(query)
