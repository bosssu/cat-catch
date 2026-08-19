"""Grade MediaCandidate quality / origin for UI (原片 / 链接 / 截图 / 其他)."""

from __future__ import annotations

from enum import Enum
from pathlib import Path

from app.core.models import MediaCandidate, SourceKind


class CandidateGrade(str, Enum):
    ORIGINAL = "original"  # complete local file
    FRAGMENT = "fragment"  # truncated cache blob (looks like video, not playable)
    LINK = "link"  # http url, no local
    SCREENSHOT = "screenshot"
    OTHER = "other"


def grade_candidate(c: MediaCandidate) -> CandidateGrade:
    if c.source_kind == SourceKind.SCREENSHOT:
        return CandidateGrade.SCREENSHOT
    if c.meta.get("media_complete") is False:
        return CandidateGrade.FRAGMENT
    local = c.local_path
    if local:
        try:
            if Path(local).is_file():
                # lazy integrity for video if not annotated yet
                mt = c.media_type.value if hasattr(c.media_type, "value") else str(c.media_type)
                if mt == "video" and "media_complete" not in c.meta:
                    from app.sources.media_integrity import is_media_complete

                    ok, reason = is_media_complete(local)
                    c.meta["media_complete"] = ok
                    if not ok:
                        c.meta["incomplete_reason"] = reason
                        return CandidateGrade.FRAGMENT
                return CandidateGrade.ORIGINAL
        except OSError:
            pass
    url = (c.source_url or "").strip().lower()
    if url.startswith("http://") or url.startswith("https://"):
        return CandidateGrade.LINK
    if local:
        return CandidateGrade.OTHER
    return CandidateGrade.OTHER


def grade_label_zh(g: CandidateGrade) -> str:
    return {
        CandidateGrade.ORIGINAL: "原片",
        CandidateGrade.FRAGMENT: "残片",
        CandidateGrade.LINK: "链接",
        CandidateGrade.SCREENSHOT: "截图",
        CandidateGrade.OTHER: "其他",
    }.get(g, "其他")


def apply_grades(candidates: list[MediaCandidate]) -> None:
    for c in candidates:
        g = grade_candidate(c)
        c.meta["grade"] = g.value


def session_summary(candidates: list[MediaCandidate]) -> dict:
    counts = {
        "original": 0,
        "fragment": 0,
        "link": 0,
        "screenshot": 0,
        "other": 0,
    }
    visible = 0
    for c in candidates:
        if getattr(c, "filtered_out", False):
            continue
        visible += 1
        g = grade_candidate(c)
        counts[g.value] = counts.get(g.value, 0) + 1

    parts: list[str] = []
    if counts["original"]:
        parts.append(f"{counts['original']} 原片")
    if counts["link"]:
        parts.append(f"{counts['link']} 链接")
    if counts["fragment"]:
        parts.append(f"{counts['fragment']} 残片")
    if counts["screenshot"]:
        parts.append(f"{counts['screenshot']} 截图")
    if counts["other"]:
        parts.append(f"{counts['other']} 其他")
    if not parts:
        headline = "暂无候选"
    else:
        headline = f"共 {visible} 项：" + " · ".join(parts)

    return {
        "original": counts["original"],
        "fragment": counts["fragment"],
        "link": counts["link"],
        "screenshot": counts["screenshot"],
        "other": counts["other"],
        "visible": visible,
        "headline": headline,
    }
