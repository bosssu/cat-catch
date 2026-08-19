from __future__ import annotations

import re
import threading
import time
from collections import deque
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse, urlunparse

from app.core.models import MediaCandidate, MediaType, SourceKind, utcnow

# Max ring buffer size for observed network media candidates.
DEFAULT_MAX_ITEMS = 500

_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".jfif"}
_GIF_EXT = {".gif"}
_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".ts", ".m3u8", ".mpd"}
_AUDIO_EXT = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".wma"}

_DISCORD_CDN_HOSTS = (
    "cdn.discordapp.com",
    "media.discordapp.net",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
)


def _path_ext(url: str) -> str:
    try:
        path = urlparse(url).path.lower()
    except Exception:
        path = url.lower().split("?", 1)[0]
    # strip trailing slash segments that look like filenames
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1]


def guess_media_type(url: str, mime: str = "") -> MediaType:
    """Infer MediaType from MIME and/or URL path extension."""
    m = (mime or "").lower().strip().split(";")[0].strip()
    if m:
        if m == "image/gif" or m.endswith("+gif"):
            return MediaType.GIF
        if m.startswith("image/"):
            return MediaType.IMAGE
        if m.startswith("video/"):
            return MediaType.VIDEO
        if m.startswith("audio/"):
            return MediaType.AUDIO
        if m in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml"):
            return MediaType.VIDEO

    ext = _path_ext(url)
    if ext in _GIF_EXT:
        return MediaType.GIF
    if ext in _IMAGE_EXT:
        return MediaType.IMAGE
    if ext in _VIDEO_EXT:
        return MediaType.VIDEO
    if ext in _AUDIO_EXT:
        return MediaType.AUDIO
    # Discord CDN often serves images without clear mime in inbox
    if "discord" in (url or "").lower() and any(
        x in url.lower() for x in ("/attachments/", "/ephemeral-attachments/", "/avatars/", "/icons/")
    ):
        return MediaType.IMAGE
    return MediaType.IMAGE


def parse_discord_dimensions(url: str) -> tuple[int | None, int | None]:
    """Parse width/height from discord-like query strings (width=, height=)."""
    try:
        q = parse_qs(urlparse(url).query)
    except Exception:
        return None, None
    w = h = None
    for key in ("width", "w"):
        if key in q and q[key]:
            try:
                w = int(q[key][0])
                break
            except (TypeError, ValueError):
                pass
    for key in ("height", "h"):
        if key in q and q[key]:
            try:
                h = int(q[key][0])
                break
            except (TypeError, ValueError):
                pass
    return w, h


def dedupe_key_for_url(url: str) -> str:
    """
    Dedup key: strip query for most hosts; keep full URL for Discord CDN
    (query often encodes size variants that are useful to distinguish).
    """
    u = (url or "").strip()
    if not u:
        return ""
    try:
        p = urlparse(u)
        host = (p.netloc or "").lower()
        if any(host == h or host.endswith("." + h) for h in _DISCORD_CDN_HOSTS):
            return u
        # strip fragment + query
        return urlunparse((p.scheme, p.netloc, p.path, "", "", ""))
    except Exception:
        return u.split("#", 1)[0]


def title_from_url(url: str) -> str:
    try:
        name = urlparse(url).path.rsplit("/", 1)[-1]
    except Exception:
        name = url.rsplit("/", 1)[-1]
    name = name.split("?", 1)[0]
    return name[:80] if name else url[:80]


class NetworkSentry:
    """
    Thread-safe ring buffer of network media observations.
    Fills pipeline candidates by PID / process name without full MITM.

    Optional claim_hook (e.g. registry.claim_network_url) enriches candidates
    with extension_id / suggested_tags via L-A/L-B when observe() runs.
    """

    def __init__(self, max_items: int = DEFAULT_MAX_ITEMS):
        self._max = max(10, int(max_items))
        self._lock = threading.RLock()
        self._items: deque[MediaCandidate] = deque(maxlen=self._max)
        # key -> candidate id currently in ring
        self._by_key: dict[str, str] = {}
        self._running = False
        self._claim_hook: Callable[..., list] | None = None

    def set_claim_hook(self, hook: Callable[..., list] | None) -> None:
        """
        Callable signature:
          hook(url, *, pid, process_name, mime="", bytes_hint=None, headers=None) -> list[MediaCandidate]
        When set, observe() prefers the first claimed candidate (extension-aware).
        """
        self._claim_hook = hook

    def start(self) -> None:
        with self._lock:
            self._running = True

    def stop(self) -> None:
        with self._lock:
            self._running = False

    @property
    def running(self) -> bool:
        with self._lock:
            return self._running

    def observe(
        self,
        url: str,
        *,
        pid: int | None = None,
        process_name: str = "",
        mime: str = "",
        content_length: int | None = None,
        headers: dict[str, str] | None = None,
        referer: str = "",
        bytes_hint: int | None = None,
    ) -> MediaCandidate | None:
        """
        Record a network URL as MediaCandidate (SourceKind.NETWORK).
        If claim_hook is set, uses L-A/L-B claimed candidates (extension_id, tags).
        Deduplicates by URL key; updates metadata on re-observe.
        Returns the primary candidate, or None if url empty / explicitly rejected.
        """
        url = (url or "").strip()
        if not url:
            return None

        hdrs: dict[str, str] = dict(headers or {})
        if referer and "Referer" not in hdrs and "referer" not in hdrs:
            hdrs["Referer"] = referer
        size = content_length if content_length is not None else bytes_hint

        claimed: list[MediaCandidate] = []
        if self._claim_hook is not None:
            try:
                claimed = list(
                    self._claim_hook(
                        url,
                        pid=pid,
                        process_name=process_name,
                        mime=mime or "",
                        bytes_hint=size,
                        headers=hdrs,
                    )
                    or []
                )
            except Exception:
                claimed = []
            if not claimed:
                # Explicit L-A reject (e.g. avatars) or non-media — do not buffer
                return None

        key = dedupe_key_for_url(url)
        if claimed:
            base = claimed[0]
            mt = base.media_type
            width, height = base.width, base.height
            if width is None and height is None:
                width, height = parse_discord_dimensions(url)
            ext_id = base.extension_id
            meta_extra = dict(base.meta or {})
            title = base.title or title_from_url(url)
            if size is None:
                size = base.bytes_hint
            if not mime and base.mime:
                mime = base.mime
            if base.headers:
                hdrs = {**base.headers, **hdrs}
        else:
            mt = guess_media_type(url, mime)
            width, height = parse_discord_dimensions(url)
            ext_id = None
            meta_extra = {}
            title = title_from_url(url)

        with self._lock:
            # update existing if same key still in buffer
            if key and key in self._by_key:
                cid = self._by_key[key]
                for c in self._items:
                    if c.id == cid:
                        if pid is not None:
                            c.pid = pid
                        if process_name:
                            c.process_name = process_name
                        if mime:
                            c.mime = mime
                        if size is not None:
                            c.bytes_hint = int(size)
                        if width is not None:
                            c.width = width
                        if height is not None:
                            c.height = height
                        if hdrs:
                            c.headers.update(hdrs)
                        if ext_id:
                            c.extension_id = ext_id
                        if meta_extra:
                            c.meta.update(meta_extra)
                        c.captured_at = utcnow()
                        c.source_url = url  # keep latest full URL
                        c.media_type = mt
                        return c

            meta = {"dedupe_key": key, **meta_extra}
            cand = MediaCandidate(
                media_type=mt,
                source_kind=SourceKind.NETWORK,
                extension_id=ext_id,
                process_name=process_name or "",
                pid=pid,
                title=title,
                source_url=url,
                bytes_hint=int(size) if size is not None else None,
                width=width,
                height=height,
                mime=mime or None,
                headers=hdrs,
                meta=meta,
            )

            # if ring drops oldest, clean index
            if len(self._items) >= self._max:
                old = self._items[0]
                old_key = (old.meta or {}).get("dedupe_key") or dedupe_key_for_url(old.source_url)
                if old_key in self._by_key and self._by_key[old_key] == old.id:
                    del self._by_key[old_key]

            self._items.append(cand)
            if key:
                self._by_key[key] = cand.id

            # buffer any extra candidates from multi-claim (same pid)
            for extra in claimed[1:]:
                ek = dedupe_key_for_url(extra.source_url or url)
                if ek and ek in self._by_key:
                    continue
                if not extra.extension_id and ext_id:
                    extra.extension_id = ext_id
                if extra.pid is None:
                    extra.pid = pid
                if not extra.process_name:
                    extra.process_name = process_name or ""
                extra.meta = {**(extra.meta or {}), "dedupe_key": ek or key}
                if len(self._items) >= self._max:
                    dropped = self._items[0]
                    dk = (dropped.meta or {}).get("dedupe_key") or dedupe_key_for_url(dropped.source_url)
                    if dk in self._by_key and self._by_key[dk] == dropped.id:
                        del self._by_key[dk]
                self._items.append(extra)
                if ek:
                    self._by_key[ek] = extra.id

            return cand

    def candidates_for_pid(self, pid: int | None) -> list[MediaCandidate]:
        if pid is None:
            return []
        with self._lock:
            return [c for c in self._items if c.pid == pid]

    def candidates_for_process(self, name: str) -> list[MediaCandidate]:
        if not name:
            return []
        needle = name.lower().removesuffix(".exe")
        with self._lock:
            out: list[MediaCandidate] = []
            for c in self._items:
                pn = (c.process_name or "").lower().removesuffix(".exe")
                if pn == needle or needle in pn or pn in needle:
                    out.append(c)
            return out

    def all_recent(self, seconds: float = 120) -> list[MediaCandidate]:
        now = time.time()
        with self._lock:
            out: list[MediaCandidate] = []
            for c in self._items:
                try:
                    ts = c.captured_at.timestamp()
                except Exception:
                    continue
                if now - ts <= seconds:
                    out.append(c)
            return out

    def clear_old(self, max_age_seconds: float = 600) -> int:
        """Drop entries older than max_age_seconds. Returns number removed."""
        now = time.time()
        with self._lock:
            keep: deque[MediaCandidate] = deque(maxlen=self._max)
            removed = 0
            self._by_key.clear()
            for c in self._items:
                try:
                    ts = c.captured_at.timestamp()
                except Exception:
                    ts = now
                if now - ts > max_age_seconds:
                    removed += 1
                    continue
                keep.append(c)
                key = (c.meta or {}).get("dedupe_key") or dedupe_key_for_url(c.source_url)
                if key:
                    self._by_key[key] = c.id
            self._items = keep
            return removed

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._by_key.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)
