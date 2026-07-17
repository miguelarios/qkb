"""Model download/cache resolution for the local provider. Offline: the
network fetch is injected; the real httpx download is tested against a
MockTransport."""

from pathlib import Path

import httpx
import pytest

from qkb.embed.models import _download, ensure_model, gguf_url


def test_gguf_url():
    assert gguf_url("example-org/some-model-GGUF", "some-model-Q8_0.gguf") == (
        "https://huggingface.co/example-org/some-model-GGUF/resolve/main/some-model-Q8_0.gguf"
    )


def test_ensure_model_returns_cached_file_without_fetching(tmp_path):
    target = tmp_path / "model.gguf"
    target.write_bytes(b"GGUF-bytes")

    def fetch(url: str, dest: Path) -> None:  # pragma: no cover - must not run
        raise AssertionError("fetch called despite cached model")

    assert ensure_model("example-org/x", "model.gguf", tmp_path, fetch=fetch) == target


def test_ensure_model_downloads_then_renames_atomically(tmp_path):
    calls: list[tuple[str, Path]] = []

    def fetch(url: str, dest: Path) -> None:
        calls.append((url, dest))
        dest.write_bytes(b"GGUF-bytes")

    cache = tmp_path / "models"  # does not exist yet: ensure_model must create it
    path = ensure_model("example-org/x", "model.gguf", cache, fetch=fetch)

    assert path == cache / "model.gguf"
    assert path.read_bytes() == b"GGUF-bytes"
    assert calls == [
        ("https://huggingface.co/example-org/x/resolve/main/model.gguf", cache / "model.gguf.part")
    ]
    assert not (cache / "model.gguf.part").exists()


def test_ensure_model_cleans_up_partial_on_fetch_failure(tmp_path):
    def fetch(url: str, dest: Path) -> None:
        dest.write_bytes(b"trunc")
        raise RuntimeError("network died")

    with pytest.raises(RuntimeError, match="network died"):
        ensure_model("example-org/x", "model.gguf", tmp_path, fetch=fetch)
    assert not (tmp_path / "model.gguf").exists()
    assert not (tmp_path / "model.gguf.part").exists()


def test_download_streams_body_and_follows_redirects(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/resolve/main/model.gguf":
            return httpx.Response(302, headers={"location": "https://cdn.example.com/blob"})
        return httpx.Response(200, content=b"GGUF-bytes")

    dest = tmp_path / "model.gguf.part"
    _download(
        "https://huggingface.co/resolve/main/model.gguf",
        dest,
        transport=httpx.MockTransport(handler),
    )
    assert dest.read_bytes() == b"GGUF-bytes"


def test_download_raises_on_http_error(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    dest = tmp_path / "model.gguf.part"
    with pytest.raises(RuntimeError, match="download failed"):
        _download("https://huggingface.co/missing", dest, transport=httpx.MockTransport(handler))
