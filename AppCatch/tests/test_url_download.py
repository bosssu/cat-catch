from __future__ import annotations

from pathlib import Path
from unittest import mock

import httpx
import pytest
import respx

from app.core.models import MediaCandidate, MediaType, SourceKind
from app.sources.url_download import (
    DownloadResult,
    download_direct,
    download_ytdlp,
    is_direct_media_url,
    materialize_candidate,
    resolve_to_local,
)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://cdn.example.com/a/b/photo.JPG", True),
        ("https://cdn.example.com/vid.mp4?token=1", True),
        ("https://cdn.discordapp.com/attachments/1/2/file.png", True),
        ("https://media.discordapp.net/attachments/1/2/x.webp", True),
        ("https://i.imgur.com/abc123.png", True),
        ("https://example.com/watch?v=xyz", False),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", False),
        ("https://example.com/page", False),
        ("not-a-url", False),
        ("", False),
        ("https://example.com/path/video.webm", True),
        ("https://example.com/a.m3u8", True),
    ],
)
def test_is_direct_media_url(url: str, expected: bool):
    assert is_direct_media_url(url) is expected


@respx.mock
def test_download_direct_writes_file(tmp_path: Path):
    url = "https://cdn.example.com/files/hello.png"
    route = respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"\x89PNG\r\n\x1a\n" + b"\x00" * 32,
            headers={"content-type": "image/png"},
        )
    )
    r = download_direct(url, tmp_path)
    assert route.called
    assert r.ok
    assert r.method == "direct"
    assert r.path is not None
    p = Path(r.path)
    assert p.is_file()
    assert p.parent == tmp_path.resolve() or p.parent == tmp_path
    assert p.read_bytes().startswith(b"\x89PNG")
    assert p.name.lower().endswith(".png")


@respx.mock
def test_download_direct_http_error(tmp_path: Path):
    url = "https://cdn.example.com/missing.jpg"
    respx.get(url).mock(return_value=httpx.Response(404, content=b"nope"))
    r = download_direct(url, tmp_path)
    assert not r.ok
    assert r.path is None
    assert "404" in r.error


@respx.mock
def test_download_direct_respects_max_bytes(tmp_path: Path):
    url = "https://cdn.example.com/big.bin"
    respx.get(url).mock(
        return_value=httpx.Response(200, content=b"x" * 1000, headers={"content-type": "application/octet-stream"})
    )
    r = download_direct(url, tmp_path, max_bytes=100)
    assert not r.ok
    assert "max_bytes" in r.error


def test_materialize_candidate_local_exists(tmp_path: Path):
    f = tmp_path / "exist.mp4"
    f.write_bytes(b"data")
    cand = MediaCandidate(
        media_type=MediaType.VIDEO,
        source_kind=SourceKind.FILE,
        local_path=str(f),
    )
    r = materialize_candidate(cand, tmp_path / "dl")
    assert r.ok
    assert r.method == "local"
    assert Path(r.path).is_file()


def test_materialize_candidate_no_source_fails(tmp_path: Path):
    cand = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.CACHE,
        local_path=None,
        source_url="",
    )
    r = materialize_candidate(cand, tmp_path)
    assert not r.ok
    assert "no local" in r.error.lower() or "source_url" in r.error.lower()


def test_download_ytdlp_missing_returns_not_ok(tmp_path: Path):
    import builtins

    real_import = builtins.__import__

    def _block_ytdlp(name, *a, **k):
        if name == "yt_dlp" or name.startswith("yt_dlp."):
            raise ImportError("blocked")
        return real_import(name, *a, **k)

    with mock.patch("builtins.__import__", side_effect=_block_ytdlp):
        with mock.patch("app.sources.url_download._ytdlp_available", return_value=False):
            r = download_ytdlp("https://www.youtube.com/watch?v=x", tmp_path)
    assert not r.ok
    assert r.method == "ytdlp"
    assert "yt-dlp not installed" in r.error or "not installed" in r.error.lower()


@respx.mock
def test_resolve_direct_url_uses_direct(tmp_path: Path):
    url = "https://cdn.example.com/clip.mp4"
    respx.get(url).mock(
        return_value=httpx.Response(200, content=b"ftypisom" + b"\x00" * 20, headers={"content-type": "video/mp4"})
    )
    with mock.patch("app.sources.url_download.download_ytdlp") as y:
        r = resolve_to_local(url, tmp_path, prefer_ytdlp=True)
        y.assert_not_called()
    assert r.ok
    assert r.method == "direct"


@respx.mock
def test_materialize_sets_local_path(tmp_path: Path):
    url = "https://cdn.example.com/pic.webp"
    respx.get(url).mock(
        return_value=httpx.Response(200, content=b"RIFF" + b"\x00" * 16, headers={"content-type": "image/webp"})
    )
    cand = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url=url,
    )
    r = materialize_candidate(cand, tmp_path, prefer_ytdlp=False)
    assert r.ok
    assert cand.local_path
    assert Path(cand.local_path).is_file()


def test_download_result_dataclass():
    r = DownloadResult(ok=False, path=None, error="e", method="direct")
    assert r.ok is False
