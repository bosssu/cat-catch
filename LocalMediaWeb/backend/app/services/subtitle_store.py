"""Sidecar SRT for a media id. The video file is not replaced."""

from __future__ import annotations

import re
from pathlib import Path

from app.core.config import get_settings

_TIME_LINE = re.compile(
    r"(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})"
)


class SubtitleStoreError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def subtitle_path(media_id: int) -> Path:
    return get_settings().subtitles_path() / f"{int(media_id)}.srt"


def subtitle_rev(media_id: int) -> int:
    path = subtitle_path(media_id)
    try:
        if path.is_file() and path.stat().st_size > 0:
            return int(path.stat().st_mtime)
    except OSError:
        return 0
    return 0


def has_subtitle(media_id: int) -> bool:
    path = subtitle_path(media_id)
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def read_srt(media_id: int) -> str:
    path = subtitle_path(media_id)
    if not path.is_file():
        raise SubtitleStoreError("没有字幕", status_code=404)
    return path.read_text(encoding="utf-8-sig")


def save_srt(media_id: int, text: str) -> None:
    body = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not body:
        raise SubtitleStoreError("字幕为空", status_code=400)
    if "-->" not in body:
        raise SubtitleStoreError("不是 SRT（缺少时间轴）", status_code=400)
    if len(body.encode("utf-8")) > 2_000_000:
        raise SubtitleStoreError("字幕过大", status_code=400)
    dest = subtitle_path(media_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".srt.partial")
    tmp.write_text(body + "\n", encoding="utf-8")
    tmp.replace(dest)


def delete_subtitle(media_id: int) -> None:
    path = subtitle_path(media_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def srt_to_vtt(srt: str) -> str:
    text = (srt or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if text.upper().startswith("WEBVTT"):
        return text + "\n"
    body = _TIME_LINE.sub(r"\1.\2 --> \3.\4", text)
    return "WEBVTT\n\n" + body + "\n"
