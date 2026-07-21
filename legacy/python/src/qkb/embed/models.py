"""GGUF model resolution for the local (in-process) embedding provider.

QMD-style: models are fetched once from HuggingFace into a local cache dir
and reused forever after. The download goes to a `.part` file and is
renamed into place atomically so an interrupted download never leaves a
truncated GGUF for llama.cpp to choke on.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path

import httpx

_CHUNK = 1024 * 1024


def gguf_url(repo: str, filename: str) -> str:
    return f"https://huggingface.co/{repo}/resolve/main/{filename}"


def _download(url: str, dest: Path, transport: httpx.BaseTransport | None = None) -> None:
    try:
        with httpx.Client(follow_redirects=True, timeout=60.0, transport=transport) as client:
            with client.stream("GET", url) as resp:
                resp.raise_for_status()
                with dest.open("wb") as f:
                    for chunk in resp.iter_bytes(_CHUNK):
                        f.write(chunk)
    except httpx.HTTPError as e:
        raise RuntimeError(f"model download failed for {url}: {e}") from e


def ensure_model(
    repo: str,
    filename: str,
    cache_dir: Path,
    fetch: Callable[[str, Path], None] | None = None,
) -> Path:
    """Return the local path of the GGUF, downloading it on first use."""
    target = cache_dir / filename
    if target.is_file():
        return target
    cache_dir.mkdir(parents=True, exist_ok=True)
    url = gguf_url(repo, filename)
    print(f"qkb: downloading embedding model {filename} to {cache_dir} ...", file=sys.stderr)
    tmp = target.with_name(target.name + ".part")
    try:
        (fetch or _download)(url, tmp)
        tmp.replace(target)
    finally:
        tmp.unlink(missing_ok=True)
    print(f"qkb: model cached at {target}", file=sys.stderr)
    return target
