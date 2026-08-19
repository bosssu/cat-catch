"""Shared pure helpers for guessing media type from URL / MIME."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from app.core.models import MediaType

_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".jfif"}
_GIF_EXT = {".gif"}
_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".ts", ".m3u8", ".mpd"}
_AUDIO_EXT = {".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac", ".opus", ".wma"}

_MEDIA_HOST_HINTS = (
    "cdn.discordapp.com",
    "media.discordapp.net",
    "i.imgur.com",
    "media.tenor.com",
    "c.tenor.com",
)

_PATH_MEDIA_RE = re.compile(
    r"\.(jpe?g|png|webp|gif|bmp|avif|mp4|webm|mkv|mov|m4v|avi|mp3|m4a|ogg|wav|m3u8|mpd)(?:$|[?#/])",
    re.I,
)

_STRIP_QUERY_KEYS = frozenset(
    {
        "ex",
        "is",
        "hm",
        "x-expires",
        "x-signature",
        "signature",
        "sig",
        "token",
        "expires",
        "expiry",
        "t",
        "_",
        "cache",
        "v",
        "ver",
        "version",
        "timestamp",
        "ts",
        "cb",
        "r",
        "rand",
        "size",
        "width",
        "height",
        "quality",
        "format",
    }
)


def _path_suffix(url: str) -> str:
    path = urlparse(url).path or ""
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1].lower()


def guess_media_type(url: str, mime: str | None = None) -> MediaType:
    """Best-effort media type from MIME and/or URL extension. Defaults to IMAGE."""
    if mime:
        m = mime.lower().split(";")[0].strip()
        if m == "image/gif":
            return MediaType.GIF
        if m.startswith("image/"):
            return MediaType.IMAGE
        if m.startswith("video/"):
            return MediaType.VIDEO
        if m.startswith("audio/"):
            return MediaType.AUDIO
        if m in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml"):
            return MediaType.VIDEO

    ext = _path_suffix(url or "")
    if ext in _GIF_EXT:
        return MediaType.GIF
    if ext in _VIDEO_EXT:
        return MediaType.VIDEO
    if ext in _AUDIO_EXT:
        return MediaType.AUDIO
    if ext in _IMAGE_EXT:
        return MediaType.IMAGE
    # Discord attachments often end with .mp4 in path; also check raw string
    ul = (url or "").lower()
    if any(x in ul for x in (".mp4", ".webm", ".mov", ".mkv", ".m4v")):
        return MediaType.VIDEO
    return MediaType.IMAGE


def is_likely_media_url(url: str, mime: str = "") -> bool:
    """True if URL/MIME looks like a direct media asset (not a page)."""
    if mime:
        m = mime.lower().split(";")[0].strip()
        if m.startswith(("image/", "video/", "audio/")):
            return True
        if m in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml"):
            return True
    if not url or not str(url).lower().startswith(("http://", "https://")):
        return False
    u = url.lower()
    if any(h in u for h in _MEDIA_HOST_HINTS):
        if _PATH_MEDIA_RE.search(u) or _path_suffix(url):
            return True
        if "cdn.discordapp.com" in u or "media.discordapp.net" in u:
            return True
        if "/attachments/" in u or "/ephemeral-attachments/" in u:
            return True
    if _PATH_MEDIA_RE.search(u):
        return True
    # known media mime already handled; extension-less non-CDN pages are not media
    return False


def strip_url_key(url: str) -> str:
    """Normalize URL for dedupe: drop fragment and volatile query params."""
    if not url:
        return ""
    try:
        p = urlparse(url)
        q = [
            (k, v)
            for k, v in parse_qsl(p.query, keep_blank_values=True)
            if k.lower() not in _STRIP_QUERY_KEYS
        ]
        q.sort(key=lambda kv: kv[0].lower())
        return urlunparse((p.scheme.lower(), p.netloc.lower(), p.path, "", urlencode(q), ""))
    except Exception:
        return url.split("#", 1)[0]
