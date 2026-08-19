"""Discord CDN L-B hooks — scan local cache/downloads for video/images; filter noise."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from app.core.models import MediaCandidate, MediaType, SourceKind
from app.sources.cache_sentry import CacheSentry, sniff_media
from app.sources.media_integrity import is_media_complete

_SKIP_FRAGMENTS = (
    "/avatars/",
    "/avatar/",
    "/emojis/",
    "/emoji/",
    "/icons/",
    "/app-icons/",
    "/embed/avatars/",
    "/role-icons/",
    "/stickers/",
    "/badges/",
)

_VIDEO_EXTS = (".mp4", ".webm", ".mov", ".mkv", ".m4v")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_MIN_IMAGE_BYTES = 100_000
_MIN_VIDEO_BYTES = 80_000


def collect_candidates(ctx: Any, session: Any) -> list:
    """Find recent Discord videos and large images on disk (cache + Downloads)."""
    out: list[MediaCandidate] = []
    proc = getattr(session, "process_name", "") or "Discord.exe"
    pid = getattr(session, "pid", None)

    try:
        sentry = CacheSentry(cfg=getattr(ctx, "cfg", None))
        cached = sentry.collect_for_process(
            proc,
            pid,
            newer_than_sec=7200,
            limit=80,
            min_bytes=80_000,
            max_depth=8,
        )
        for c in cached:
            if c.media_type == MediaType.VIDEO:
                # Cache_Data blobs are often truncated (mdat claims 10MB, file 200KB)
                if c.local_path:
                    ok, reason = is_media_complete(c.local_path)
                    if not ok:
                        ctx.log(f"skip incomplete cache video: {c.local_path} ({reason})")
                        continue
                c.extension_id = "discord.cdn"
                c.meta = dict(c.meta or {})
                c.meta["suggested_tags"] = ["discord", "video"]
                c.meta["media_complete"] = True
                c.score = max(float(c.score or 0), 0.8)
                out.append(c)
            elif c.media_type in (MediaType.IMAGE, MediaType.GIF):
                size = int(c.bytes_hint or 0)
                if size < _MIN_IMAGE_BYTES:
                    continue
                c.extension_id = "discord.cdn"
                c.meta = dict(c.meta or {})
                tag = "gif" if c.media_type == MediaType.GIF else "image"
                c.meta["suggested_tags"] = ["discord", tag]
                c.score = max(float(c.score or 0), 0.65)
                out.append(c)
    except Exception as e:
        ctx.log(f"cache media scan failed: {e}")

    try:
        dl = Path(os.path.expandvars(r"%USERPROFILE%\Downloads"))
        if dl.is_dir():
            cutoff = time.time() - 7200
            found: list[tuple[float, Path, MediaType, str, float]] = []
            for p in dl.iterdir():
                if not p.is_file():
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                if st.st_mtime < cutoff:
                    continue
                name = p.name.lower()
                if any(name.endswith(ext) for ext in _VIDEO_EXTS):
                    if st.st_size < _MIN_VIDEO_BYTES:
                        continue
                    ok, _ = is_media_complete(p)
                    if not ok:
                        continue
                    mime = "video/webm" if name.endswith(".webm") else "video/mp4"
                    found.append((st.st_mtime, p, MediaType.VIDEO, mime, 0.8))
                    continue
                if any(name.endswith(ext) for ext in _IMAGE_EXTS):
                    if st.st_size < _MIN_IMAGE_BYTES:
                        continue
                    if name.endswith(".gif"):
                        mt, mime, score = MediaType.GIF, "image/gif", 0.65
                    elif name.endswith(".webp"):
                        mt, mime, score = MediaType.IMAGE, "image/webp", 0.65
                    elif name.endswith((".jpg", ".jpeg")):
                        mt, mime, score = MediaType.IMAGE, "image/jpeg", 0.65
                    else:
                        mt, mime, score = MediaType.IMAGE, "image/png", 0.65
                    found.append((st.st_mtime, p, mt, mime, score))
                    continue
                sniffed = sniff_media(p)
                if not sniffed:
                    continue
                smt, smime = sniffed[0], sniffed[1]
                if smt == MediaType.VIDEO and st.st_size >= _MIN_VIDEO_BYTES:
                    found.append((st.st_mtime, p, MediaType.VIDEO, smime, 0.8))
                elif smt in (MediaType.IMAGE, MediaType.GIF) and st.st_size >= _MIN_IMAGE_BYTES:
                    found.append((st.st_mtime, p, smt, smime, 0.65))
            found.sort(key=lambda x: x[0], reverse=True)
            for _mt, p, media_type, mime, score in found[:20]:
                st = p.stat()
                tag = (
                    "video"
                    if media_type == MediaType.VIDEO
                    else ("gif" if media_type == MediaType.GIF else "image")
                )
                out.append(
                    MediaCandidate(
                        media_type=media_type,
                        source_kind=SourceKind.FILE,
                        extension_id="discord.cdn",
                        process_name=proc,
                        pid=pid,
                        title=p.name,
                        source_url=f"appcatch://downloads/{p.name}",
                        local_path=str(p),
                        bytes_hint=st.st_size,
                        mime=mime,
                        score=score,
                        meta={"suggested_tags": ["discord", tag, "downloads"]},
                    )
                )
    except Exception as e:
        ctx.log(f"downloads scan failed: {e}")

    ctx.log(f"discord collect media={len(out)}")
    return out


def on_network_item(ctx: Any, session: Any, raw: Any) -> list:
    """
    Extra filter only. L-A already builds candidates; returning more would duplicate.
    Return [] always after optional log; exclude is handled by manifest.
    """
    raw = raw or {}
    url = str(raw.get("url") or raw.get("source_url") or "")
    low = url.lower()
    if any(f in low for f in _SKIP_FRAGMENTS):
        ctx.log(f"skip avatar/emoji: {url[:100]}")
    return []


def before_ingest(ctx: Any, candidate: Any) -> Any:
    return candidate
