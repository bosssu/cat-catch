from __future__ import annotations

from pathlib import Path

from app.core.config import AppConfig
from app.core.models import MediaCandidate, MediaType
from app.sources.media_integrity import annotate_candidate_integrity, is_media_complete

# Common avatar / emoji-ish square sizes
_AVATAR_SIZES = {16, 24, 32, 40, 48, 64, 80, 96, 128, 160, 256}


def apply_filters(candidates: list[MediaCandidate], cfg: AppConfig) -> list[MediaCandidate]:
    allowed = set(cfg.get("capture", "types", default=["image", "gif", "video"]) or [])
    min_edge = int(cfg.get("capture", "min_edge_px", default=0) or 0)
    min_bytes = int(cfg.get("capture", "min_bytes", default=0) or 0)
    skip_avatar = bool(cfg.get("capture", "skip_avatar_like", default=True))
    skip_incomplete = bool(cfg.get("capture", "skip_incomplete_video", default=True))

    out: list[MediaCandidate] = []
    for c in candidates:
        c.filtered_out = False
        c.filter_reason = ""

        mt = c.media_type.value if isinstance(c.media_type, MediaType) else str(c.media_type)
        if allowed and mt not in allowed:
            c.filtered_out = True
            c.filter_reason = f"类型 {mt} 已关闭"
            out.append(c)
            continue

        if min_bytes and c.bytes_hint is not None and c.bytes_hint < min_bytes:
            c.filtered_out = True
            c.filter_reason = f"小于 {min_bytes} 字节"
            out.append(c)
            continue

        edge = c.min_edge
        if min_edge and edge is not None and edge < min_edge:
            c.filtered_out = True
            c.filter_reason = f"边长 {edge} < {min_edge}"
            out.append(c)
            continue

        if skip_avatar and _looks_avatar(c):
            c.filtered_out = True
            c.filter_reason = "像头像/emoji"
            out.append(c)
            continue

        url = (c.source_url or "").lower()
        if skip_avatar and any(x in url for x in ("/avatars/", "/emoji", "/emojis/", "profile_images")):
            c.filtered_out = True
            c.filter_reason = "URL 像头像/emoji"
            out.append(c)
            continue

        # Truncated Discord/Electron cache videos (mdat larger than file)
        if mt == "video" and c.local_path and Path(c.local_path).is_file():
            complete = annotate_candidate_integrity(c)
            if skip_incomplete and not complete:
                c.filtered_out = True
                reason = c.meta.get("incomplete_reason") or "缓存视频不完整"
                c.filter_reason = f"残片不可播: {reason}"
                out.append(c)
                continue

        out.append(c)
    return out


def _looks_avatar(c: MediaCandidate) -> bool:
    if c.width is None or c.height is None:
        return False
    if c.width != c.height:
        return False
    return c.width in _AVATAR_SIZES


def is_quality(c: MediaCandidate) -> bool:
    """Default auto-check in grid: not filtered and score ok or has decent size."""
    if c.filtered_out:
        return False
    if c.source_kind.value == "screenshot":
        return True
    edge = c.min_edge
    if edge is not None and edge >= 400:
        return True
    if c.bytes_hint is not None and c.bytes_hint >= 80_000:
        return True
    if c.score >= 0.5:
        return True
    # unknown dimensions but not filtered — still quality candidate
    if edge is None and not c.filtered_out:
        return True
    return False
