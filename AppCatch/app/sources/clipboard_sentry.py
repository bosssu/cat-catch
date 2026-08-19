from __future__ import annotations

import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from app.core.config import ROOT
from app.core.models import MediaCandidate, MediaType, SourceKind
from app.sources.network_sentry import guess_media_type, title_from_url

_MEDIA_EXT = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".mp4",
    ".webm",
    ".mkv",
    ".mov",
    ".mp3",
    ".m4a",
    ".wav",
    ".flac",
    ".ogg",
)

_URL_RE = re.compile(
    r"https?://[^\s<>\"']+",
    re.IGNORECASE,
)

# Host / path substring allowlist for clipboard media URLs
_MEDIA_HOST_FRAGMENTS = (
    "cdn.discordapp.com",
    "media.discordapp.net",
    "discordapp.com/attachments",
    "discord.com/attachments",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "i.imgur.com",
    "pbs.twimg.com",
    "video.twimg.com",
    "youtube.com",
    "youtu.be",
    "googlevideo.com",
    "bilibili.com",
    "bilivideo.com",
    "hdslb.com",
    "streamable.com",
    "giphy.com",
    "tenor.com",
)

_DISCORD_DOMAIN_FRAGMENTS = (
    "discordapp.com",
    "discord.com",
    "discordapp.net",
    "discord.gg",
)


def _tmp_dir() -> Path:
    d = ROOT / "data" / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _is_discordish_url(url: str) -> bool:
    low = url.lower()
    return any(frag in low for frag in _DISCORD_DOMAIN_FRAGMENTS)


def extract_media_urls(text: str) -> list[str]:
    """Pure helper: media-looking http(s) URLs from free text."""
    if not text:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(text):
        u = m.group(0).rstrip(").,];'\"")
        if u in seen:
            continue
        low = u.lower()
        path = urlparse(u).path.lower()
        path_has_media_ext = any(path.endswith(ext) for ext in _MEDIA_EXT)
        host_ok = any(host in low for host in _MEDIA_HOST_FRAGMENTS)
        path_ok = (
            "/attachments/" in path
            or path.endswith(".m3u8")
            or path.endswith(".mpd")
            or path.endswith("m3u8")
            or path.endswith("mpd")
        )
        # Discord attachment URLs often lack a file extension (query strings, signed URLs)
        discord_long = (
            low.startswith("https://")
            and len(u) > 20
            and _is_discordish_url(u)
        )
        if path_has_media_ext or host_ok or path_ok or discord_long:
            seen.add(u)
            found.append(u)
    return found


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_gate(
    h: str,
    *,
    remember: bool,
    sentry: ClipboardSentry | None,
) -> bool:
    """Return True if this content should be emitted."""
    if not remember:
        return True
    if sentry is not None:
        return sentry._remember(h)
    return True


def _read_clipboard_files() -> list[str]:
    try:
        import win32clipboard
        import win32con
    except ImportError:
        return []

    paths: list[str] = []
    try:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP):
                data = win32clipboard.GetClipboardData(win32con.CF_HDROP)
                if data:
                    paths = list(data)
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        return []
    return paths


def _read_clipboard_png_bytes(dib_to_png: Callable[[bytes], bytes | None]) -> bytes | None:
    try:
        import win32clipboard
        import win32con
    except ImportError:
        return None

    try:
        win32clipboard.OpenClipboard()
        try:
            png_fmt = None
            try:
                png_fmt = win32clipboard.RegisterClipboardFormat("PNG")
            except Exception:
                png_fmt = None
            if png_fmt and win32clipboard.IsClipboardFormatAvailable(png_fmt):
                data = win32clipboard.GetClipboardData(png_fmt)
                if isinstance(data, bytes) and data:
                    return data
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_DIB):
                dib = win32clipboard.GetClipboardData(win32con.CF_DIB)
                if isinstance(dib, bytes) and dib:
                    return dib_to_png(dib)
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        return None
    return None


def _read_clipboard_text() -> str:
    try:
        import win32clipboard
        import win32con
    except ImportError:
        return ""

    text = ""
    try:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                text = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT) or ""
            elif win32clipboard.IsClipboardFormatAvailable(win32con.CF_TEXT):
                raw = win32clipboard.GetClipboardData(win32con.CF_TEXT)
                if isinstance(raw, bytes):
                    text = raw.decode("utf-8", errors="replace")
                else:
                    text = str(raw or "")
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        return ""
    return text


def dib_to_png_bytes(dib: bytes) -> bytes | None:
    """Convert CF_DIB payload to PNG bytes via Pillow."""
    try:
        import io
        import struct

        from PIL import Image

        # DIB is BITMAPINFOHEADER + pixels (no BITMAPFILEHEADER)
        if len(dib) < 40:
            return None
        header_size = struct.unpack_from("<I", dib, 0)[0]
        if header_size < 40:
            return None
        bpp = struct.unpack_from("<H", dib, 14)[0]
        # Build BMP file header
        file_header = struct.pack(
            "<2sIHHI",
            b"BM",
            14 + len(dib),
            0,
            0,
            14 + header_size,
        )
        bmp = file_header + dib
        im = Image.open(io.BytesIO(bmp))
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if bpp == 32 else "RGB")
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def snapshot_clipboard_media(
    *,
    process_name: str = "clipboard",
    pid: int | None = None,
    remember: bool = False,
    sentry: ClipboardSentry | None = None,
) -> list[MediaCandidate]:
    """
    Force-read clipboard files, image, and text URLs.

    When remember=False, do not require hash novelty (always include).
    When remember=True and sentry is provided, use sentry hash tracking.
    """
    if sys.platform != "win32":
        return []

    out: list[MediaCandidate] = []
    out.extend(
        _candidates_from_files(
            process_name=process_name,
            pid=pid,
            remember=remember,
            sentry=sentry,
        )
    )
    out.extend(
        _candidates_from_image(
            process_name=process_name,
            pid=pid,
            remember=remember,
            sentry=sentry,
        )
    )
    out.extend(
        _candidates_from_text_urls(
            process_name=process_name,
            pid=pid,
            remember=remember,
            sentry=sentry,
        )
    )
    return out


def _candidates_from_files(
    *,
    process_name: str,
    pid: int | None,
    remember: bool,
    sentry: ClipboardSentry | None,
) -> list[MediaCandidate]:
    paths = _read_clipboard_files()
    cands: list[MediaCandidate] = []
    for p in paths:
        try:
            path = Path(p)
            if not path.is_file():
                continue
            ext = path.suffix.lower()
            if ext not in _MEDIA_EXT and ext not in {".tif", ".tiff", ".avi", ".m4v"}:
                continue
            raw = path.read_bytes()[:65536]
            h = content_hash(raw + str(path.resolve()).encode("utf-8", errors="ignore"))
            if not _hash_gate(h, remember=remember, sentry=sentry):
                continue
            mime = ""
            mt = guess_media_type(str(path), mime)
            size = path.stat().st_size
            cands.append(
                MediaCandidate(
                    media_type=mt,
                    source_kind=SourceKind.FILE,
                    process_name=process_name,
                    pid=pid,
                    title=path.name,
                    source_url=path.as_uri(),
                    local_path=str(path.resolve()),
                    bytes_hint=size,
                    mime=mime or None,
                    meta={"clipboard": "hdrop", "hash": h},
                )
            )
        except Exception:
            continue
    return cands


def _candidates_from_image(
    *,
    process_name: str,
    pid: int | None,
    remember: bool,
    sentry: ClipboardSentry | None,
) -> list[MediaCandidate]:
    png_bytes = _read_clipboard_png_bytes(dib_to_png_bytes)
    if not png_bytes:
        return []

    h = content_hash(png_bytes)
    if not _hash_gate(h, remember=remember, sentry=sentry):
        return []

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = _tmp_dir() / f"clipboard_{ts}_{h[:8]}.png"
    try:
        out_path.write_bytes(png_bytes)
    except Exception:
        if not out_path.exists():
            return []

    width = height = None
    try:
        from PIL import Image
        import io

        im = Image.open(io.BytesIO(png_bytes))
        width, height = im.size
    except Exception:
        pass

    return [
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.FILE,
            process_name=process_name,
            pid=pid,
            title=f"clipboard_{ts}.png",
            source_url=f"appcatch://clipboard/{h[:12]}",
            local_path=str(out_path),
            bytes_hint=len(png_bytes),
            width=width,
            height=height,
            mime="image/png",
            thumb_path=str(out_path),
            meta={"clipboard": "image", "hash": h},
        )
    ]


def _candidates_from_text_urls(
    *,
    process_name: str,
    pid: int | None,
    remember: bool,
    sentry: ClipboardSentry | None,
    text: str | None = None,
) -> list[MediaCandidate]:
    if text is None:
        text = _read_clipboard_text()
    urls = extract_media_urls(text)
    cands: list[MediaCandidate] = []
    for u in urls:
        h = content_hash(u.encode("utf-8"))
        if not _hash_gate(h, remember=remember, sentry=sentry):
            continue
        mt = guess_media_type(u, "")
        cands.append(
            MediaCandidate(
                media_type=mt,
                source_kind=SourceKind.NETWORK,
                process_name=process_name,
                pid=pid,
                title=title_from_url(u),
                source_url=u,
                meta={"clipboard": "url", "hash": h},
            )
        )
    return cands


class ClipboardSentry:
    """
    Timer-friendly clipboard observer (no Qt dependency).
    Call poll() periodically; returns new MediaCandidate list since last poll.
    Tracks content hashes to avoid re-emitting the same clip.
    """

    def __init__(self, process_name: str = "clipboard", pid: int | None = None):
        self.process_name = process_name
        self.pid = pid
        self._seen_hashes: set[str] = set()
        # bound growth
        self._max_seen = 256

    def _remember(self, h: str) -> bool:
        """Return True if new (not seen before)."""
        if h in self._seen_hashes:
            return False
        self._seen_hashes.add(h)
        if len(self._seen_hashes) > self._max_seen:
            # drop arbitrary half
            for i, k in enumerate(list(self._seen_hashes)):
                if i % 2 == 0:
                    self._seen_hashes.discard(k)
        return True

    def poll(self) -> list[MediaCandidate]:
        return snapshot_clipboard_media(
            process_name=self.process_name,
            pid=self.pid,
            remember=True,
            sentry=self,
        )

    def snapshot(self, remember: bool = False) -> list[MediaCandidate]:
        return snapshot_clipboard_media(
            process_name=self.process_name,
            pid=self.pid,
            remember=remember,
            sentry=self,
        )

    def reset(self) -> None:
        self._seen_hashes.clear()
