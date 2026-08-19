"""Force H.264/AAC progressive MP4 re-encode and replace library media in place."""

from __future__ import annotations

import logging
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import ffmpeg_available, get_settings
from app.core.db import session_scope
from app.models.entities import MediaItem
from app.services.dedupe import hash_media_file
from app.services.media_process import align_av_timeline, encode_mobile_mp4
from app.services.thumb import generate_thumb

logger = logging.getLogger("lmw.reencode")

_lock = threading.Lock()
_in_flight: set[int] = set()


class ReencodeError(Exception):
    """User-facing re-encode failure."""

    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def is_reencode_in_flight(media_id: int) -> bool:
    with _lock:
        return media_id in _in_flight


def reencode_replace_h264(media_id: int) -> MediaItem:
    """
    Transcode media file to standardized H.264/AAC progressive MP4 and replace
    the on-disk library file. Updates size/mime/path/hash/thumb/updated_at.
    """
    if not ffmpeg_available():
        raise ReencodeError("ffmpeg 不可用，无法转码", status_code=400)

    with _lock:
        if media_id in _in_flight:
            raise ReencodeError("该媒体正在转码中，请稍候", status_code=409)
        _in_flight.add(media_id)

    try:
        return _reencode_replace_h264_unlocked(media_id)
    finally:
        with _lock:
            _in_flight.discard(media_id)


def _resolve_src(item: MediaItem, medias: Path) -> Path:
    src = medias / item.rel_path
    if src.is_file():
        return src
    alt = medias / (item.category or "default") / Path(item.rel_path).name
    if alt.is_file():
        return alt
    raise ReencodeError(f"源文件不存在: {item.rel_path}", status_code=404)


def _reencode_replace_h264_unlocked(media_id: int) -> MediaItem:
    settings = get_settings()
    medias = settings.medias_path()
    medias.mkdir(parents=True, exist_ok=True)

    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReencodeError("媒体不存在", status_code=404)
        mtype = (item.media_type or "").lower()
        if mtype not in ("video", "m3u8"):
            raise ReencodeError(
                f"仅支持视频转码（当前类型: {mtype or 'unknown'}）",
                status_code=400,
            )
        old_rel = item.rel_path
        src = _resolve_src(item, medias)
        old_path = medias / old_rel
        if not old_path.is_file():
            old_path = src

    if src.stat().st_size < 64:
        raise ReencodeError("源文件过小，无法转码", status_code=400)

    work = settings.tmp_path() / "reencode" / str(media_id)
    work.mkdir(parents=True, exist_ok=True)
    out_tmp = work / "out.mp4"
    if out_tmp.exists():
        try:
            out_tmp.unlink()
        except OSError:
            pass

    # Prefer hard A/V re-time (fixes lip-sync on already-ingested HLS mess);
    # fall back to plain mobile H.264 encode if align cannot produce output.
    logger.info("reencode start media=%s src=%s (hard av-align)", media_id, src)
    av_report: dict | None = None
    try:
        # Work on a copy so align can replace/rename without touching library yet
        src_work = work / "src_in"
        src_work = src_work.with_suffix(src.suffix or ".mp4")
        shutil.copy2(src, src_work)
        fixed, av_report = align_av_timeline(src_work, force=True, hard=True)
        if fixed.is_file() and fixed.stat().st_size >= 32:
            if fixed.resolve() != out_tmp.resolve():
                if out_tmp.exists():
                    out_tmp.unlink()
                shutil.copy2(fixed, out_tmp)
        else:
            raise RuntimeError(av_report.get("note") or "align empty")
        logger.info(
            "reencode av-align media=%s action=%s ok=%s",
            media_id,
            (av_report or {}).get("action"),
            (av_report or {}).get("ok"),
        )
    except Exception as e_align:
        logger.warning(
            "reencode hard-align failed media=%s: %s — encode_mobile_mp4",
            media_id,
            e_align,
        )
        try:
            if out_tmp.exists():
                out_tmp.unlink()
        except OSError:
            pass
        try:
            encode_mobile_mp4(src, out_tmp)
        except Exception as e:
            logger.exception("reencode ffmpeg failed media=%s", media_id)
            try:
                out_tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise ReencodeError(f"转码失败: {e}", status_code=500) from e

    if not out_tmp.is_file() or out_tmp.stat().st_size < 32:
        raise ReencodeError("转码输出无效", status_code=500)

    # Side-car probe for post-mortem (same as fresh m3u8 ingest)
    if av_report:
        try:
            import json as _json

            (work / "av_timeline.json").write_text(
                _json.dumps(av_report, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass

    stem = Path(old_rel).stem
    parent = Path(old_rel).parent
    if str(parent) == ".":
        new_rel = f"{stem}.mp4"
    else:
        new_rel = f"{parent.as_posix()}/{stem}.mp4"
    final_path = medias / new_rel

    if final_path.resolve() != old_path.resolve() and final_path.exists():
        new_rel = f"{Path(old_rel).stem}_h264_{media_id}.mp4"
        final_path = medias / new_rel

    final_path.parent.mkdir(parents=True, exist_ok=True)
    stage = final_path.with_name(final_path.name + ".partial")
    try:
        if stage.exists():
            stage.unlink()
        shutil.copy2(out_tmp, stage)
        os.replace(stage, final_path)
    except Exception as e:
        if stage.exists():
            try:
                stage.unlink()
            except OSError:
                pass
        logger.exception("reencode replace failed media=%s", media_id)
        raise ReencodeError(f"替换文件失败: {e}", status_code=500) from e
    finally:
        try:
            out_tmp.unlink(missing_ok=True)
        except OSError:
            pass

    try:
        if old_path.is_file() and old_path.resolve() != final_path.resolve():
            old_path.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("reencode could not remove old file %s: %s", old_path, e)

    # Persist av_timeline next to library file when we have a report
    try:
        work_json = work / "av_timeline.json"
        side = final_path.with_name(final_path.name + ".av_timeline.json")
        if work_json.is_file():
            shutil.copy2(work_json, side)
        elif av_report:
            import json as _json

            side.write_text(
                _json.dumps(av_report, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    except Exception as e:
        logger.debug("reencode av_timeline side-car skip: %s", e)

    chash, fsize = hash_media_file(final_path)
    size = fsize or (final_path.stat().st_size if final_path.is_file() else 0)

    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReencodeError("媒体在转码后被删除", status_code=404)
        item.rel_path = new_rel
        item.file_size = int(size)
        item.mime = "video/mp4"
        item.media_type = "video"
        if chash:
            item.content_hash = chash
        item.updated_at = datetime.now(timezone.utc)
        warn = (item.warning or "").strip()
        note = "h264_reencode_ok"
        if av_report and av_report.get("ok"):
            note = "av_hard_align_ok"
        elif av_report and not av_report.get("ok"):
            note = "av_hard_align_done"
        if note not in warn:
            item.warning = f"{warn};{note}".strip(";") if warn else note
        db.commit()

    thumb_rel = generate_thumb(final_path, media_id, "video")
    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise ReencodeError("媒体在转码后被删除", status_code=404)
        if thumb_rel:
            item.thumb_rel = thumb_rel
            item.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(item)
        else:
            db.refresh(item)
        # Access attributes while session is open for return via _media_out
        _ = (
            item.id,
            item.category,
            item.title,
            item.media_type,
            item.file_size,
            item.mime,
            item.partial,
            item.warning,
            item.liked,
            item.like_count,
            item.skip_count,
            item.view_count,
            item.tags_json,
            item.review,
            item.created_at,
            item.updated_at,
            item.rel_path,
            item.thumb_rel,
            item.source_url,
        )
        db.expunge(item)
        logger.info("reencode applied media=%s -> %s size=%s", media_id, new_rel, size)
        return item
