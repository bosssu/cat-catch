"""Replace one library video's bytes in place. Same media id."""

from __future__ import annotations

import logging
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import MediaItem
from app.services.dedupe import hash_media_file
from app.services.media_process import classify_media_file
from app.services.thumb import generate_thumb

logger = logging.getLogger("lmw.replace_file")

_lock = threading.Lock()
_in_flight: set[int] = set()


class ReplaceFileError(Exception):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def replace_library_video(media_id: int, incoming: Path, *, upload_name: str = "") -> MediaItem:
    """
    Swap the on-disk file for media_id with incoming bytes.
    Tags, likes, series, and playback position stay on the same row.
    The old file is removed only after the new file is in place.
    """
    if not incoming.is_file() or incoming.stat().st_size < 32:
        raise ReplaceFileError("替换文件无效", status_code=400)

    with _lock:
        if media_id in _in_flight:
            raise ReplaceFileError("该媒体正在替换中，请稍候", status_code=409)
        _in_flight.add(media_id)

    try:
        return _replace_unlocked(media_id, incoming, upload_name=upload_name)
    finally:
        with _lock:
            _in_flight.discard(media_id)


def _replace_unlocked(media_id: int, incoming: Path, *, upload_name: str) -> MediaItem:
    settings = get_settings()
    medias = settings.medias_path()
    medias.mkdir(parents=True, exist_ok=True)

    cls = classify_media_file(incoming, hinted="video", content_type="video/mp4")
    mtype = (cls.get("media_type") or "").lower()
    if mtype != "video" or not cls.get("has_video"):
        # ffprobe missing: accept a video-looking upload rather than blocking demosaic
        method = cls.get("method") or ""
        if not (mtype == "video" and method == "fallback"):
            raise ReplaceFileError(
                f"替换内容不是视频（{mtype or 'unknown'}）",
                status_code=400,
            )

    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReplaceFileError("媒体不存在", status_code=404)
        old_type = (item.media_type or "").lower()
        if old_type not in ("video", "m3u8"):
            raise ReplaceFileError(
                f"仅支持替换视频（当前类型: {old_type or 'unknown'}）",
                status_code=400,
            )
        old_rel = item.rel_path

    old_path = medias / old_rel
    if not old_path.is_file():
        alt = medias / "default" / Path(old_rel).name
        if alt.is_file():
            old_path = alt

    suffix = Path(upload_name or incoming.name).suffix.lower()
    if suffix not in (".mp4", ".webm", ".mkv", ".mov"):
        suffix = ".mp4"
    stem = Path(old_rel).stem
    parent = Path(old_rel).parent
    if str(parent) == ".":
        new_rel = f"{stem}{suffix}"
    else:
        new_rel = f"{parent.as_posix()}/{stem}{suffix}"
    final_path = medias / new_rel
    if final_path.resolve() != old_path.resolve() and final_path.exists():
        new_rel = f"{stem}_jasna_{media_id}{suffix}"
        final_path = medias / new_rel

    final_path.parent.mkdir(parents=True, exist_ok=True)
    stage = final_path.with_name(final_path.name + ".partial")
    try:
        if stage.exists():
            stage.unlink()
        shutil.copy2(incoming, stage)
        os.replace(stage, final_path)
    except Exception as e:
        if stage.exists():
            try:
                stage.unlink()
            except OSError:
                pass
        logger.exception("replace file failed media=%s", media_id)
        raise ReplaceFileError(f"替换文件失败: {e}", status_code=500) from e

    try:
        if old_path.is_file() and old_path.resolve() != final_path.resolve():
            old_path.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("replace could not remove old file %s: %s", old_path, e)

    chash, fsize = hash_media_file(final_path)
    size = fsize or (final_path.stat().st_size if final_path.is_file() else 0)
    mime = cls.get("mime") or "video/mp4"
    duration = cls.get("duration_sec")

    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReplaceFileError("媒体在替换后被删除", status_code=404)
        item.rel_path = new_rel
        item.file_size = int(size)
        item.mime = str(mime)
        item.media_type = "video"
        if chash:
            item.content_hash = chash
        if duration is not None:
            try:
                item.duration_sec = float(duration)
            except (TypeError, ValueError):
                pass
        item.updated_at = datetime.now(timezone.utc)
        warn = (item.warning or "").strip()
        note = "jasna_replace_ok"
        if note not in warn:
            item.warning = f"{warn};{note}".strip(";") if warn else note
        db.commit()

    thumb_rel = generate_thumb(final_path, media_id, "video")
    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReplaceFileError("媒体在替换后被删除", status_code=404)
        if thumb_rel:
            item.thumb_rel = thumb_rel
            item.updated_at = datetime.now(timezone.utc)
            db.commit()
        db.refresh(item)
        _ = (
            item.id,
            item.category,
            item.title,
            item.media_type,
            item.rel_path,
            item.file_size,
            item.mime,
            item.partial,
            item.warning,
            item.liked,
            item.tags_json,
            item.duration_sec,
            item.max_progress,
            item.last_position_sec,
            item.updated_at,
            item.thumb_rel,
        )
        db.expunge(item)
        return item
