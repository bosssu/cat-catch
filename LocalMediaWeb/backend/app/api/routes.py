from __future__ import annotations

import mimetypes
import random
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import desc, func, select

from app.api.deps import require_token
from datetime import datetime, timezone

from app.api.schemas import CategoryCreate, IngestRequest, InteractEvent, JobOut, MediaOut
from app.core.config import ffmpeg_available, get_settings, gopeed_binary_available
from app.core.db import get_db
from app.models.entities import DownloadJob, MediaItem
from app.services.download import enqueue_jobs, register_uploaded_file, request_cancel
from app.services.feed_rank import rank_recommend_with_affinity
from app.services.media_process import merge_av_to_mp4, remux_to_playable, write_temp_bytes
from app.services.scan import ensure_category, list_categories, purge_missing_media, rescan_medias
from app.services.thumb import generate_thumb, thumb_path_for
from app.services.util import detect_media_type, safe_category, safe_filename

router = APIRouter(prefix="/api")
public_router = APIRouter(prefix="/api")


def _media_out(m: MediaItem) -> MediaOut:
    return MediaOut(
        id=m.id,
        category=m.category,
        title=m.title,
        media_type=m.media_type,
        source_url=m.source_url,
        file_size=m.file_size,
        mime=m.mime,
        partial=m.partial,
        warning=m.warning or "",
        liked=bool(getattr(m, "liked", False)),
        like_count=int(getattr(m, "like_count", 0) or 0),
        skip_count=int(getattr(m, "skip_count", 0) or 0),
        view_count=int(getattr(m, "view_count", 0) or 0),
        created_at=m.created_at,
        file_url=f"/api/media/{m.id}/file",
        thumb_url=f"/api/media/{m.id}/thumb",
    )


def _job_out(j: DownloadJob) -> JobOut:
    return JobOut(
        id=j.id,
        category=j.category,
        url=j.url,
        media_type=j.media_type,
        title=j.title,
        status=j.status,
        http_status=j.http_status,
        error_message=j.error_message or "",
        client_fallback_allowed=j.client_fallback_allowed,
        progress=j.progress,
        segments_total=j.segments_total,
        segments_done=j.segments_done,
        media_id=j.media_id,
        created_at=j.created_at,
    )


@public_router.get("/health")
def health():
    s = get_settings()
    lan_ips: list[str] = []
    try:
        import socket

        # Best-effort LAN addresses for phone debugging (no external traffic)
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in lan_ips:
                lan_ips.append(ip)
    except Exception:
        pass
    return {
        "ok": True,
        "version": "0.1.0",
        "ffmpeg": ffmpeg_available(),
        "gopeed": bool(s.gopeed_enabled) and gopeed_binary_available(),
        "gopeed_enabled": bool(s.gopeed_enabled),
        "gopeed_min_bytes": int(getattr(s, "gopeed_min_bytes", 0) or 0),
        "profile": s.profile,
        "host": s.host,
        "port": s.port,
        "auth": bool(s.access_token),
        "lan_ips": lan_ips,
        # Download proxy is internal only; never required for browsing this UI
        "download_proxy_configured": bool((s.http_proxy or s.https_proxy or "").strip()),
    }


@router.get("/categories", dependencies=[Depends(require_token)])
def categories():
    return {"categories": list_categories()}


@router.post("/categories", dependencies=[Depends(require_token)])
def create_category(body: CategoryCreate):
    name = ensure_category(body.name)
    return {"name": name}


@router.get("/media", dependencies=[Depends(require_token)])
def list_media(
    category: str | None = None,
    type: str | None = None,
    q: str | None = None,
    sort: str = "new",
    offset: int = 0,
    limit: int = Query(default=50, le=200),
    db=Depends(get_db),
):
    stmt = select(MediaItem)
    if category:
        stmt = stmt.where(MediaItem.category == safe_category(category))
    if type:
        stmt = stmt.where(MediaItem.media_type == type)
    if q:
        stmt = stmt.where(MediaItem.title.contains(q) | MediaItem.source_url.contains(q))
    if sort == "old":
        stmt = stmt.order_by(MediaItem.id.asc())
    else:
        stmt = stmt.order_by(MediaItem.id.desc())
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.offset(offset).limit(limit)).all()
    return {"total": total, "items": [_media_out(m) for m in rows]}


@router.get("/feed", dependencies=[Depends(require_token)])
def feed(
    mode: str = "recommend",
    limit: int = Query(default=30, le=100),
    category: str | None = None,
    db=Depends(get_db),
):
    """
    mode:
      - recommend: personal score (like / view / skip / recency / category affinity)
      - recent: newest first
      - random: shuffle
      - liked: only liked items
    """
    stmt = select(MediaItem)
    if category:
        stmt = stmt.where(MediaItem.category == safe_category(category))
    if mode == "liked":
        stmt = stmt.where(MediaItem.liked.is_(True))
        rows = list(db.scalars(stmt.order_by(desc(MediaItem.id)).limit(limit)).all())
    elif mode == "recent":
        rows = list(db.scalars(stmt.order_by(desc(MediaItem.id)).limit(limit)).all())
    elif mode == "random":
        rows = list(db.scalars(stmt.order_by(desc(MediaItem.id)).limit(400)).all())
        random.shuffle(rows)
        rows = rows[:limit]
    else:
        # recommend: pool then rank
        pool = list(db.scalars(stmt.order_by(desc(MediaItem.id)).limit(500)).all())
        rows = rank_recommend_with_affinity(pool, limit=limit)
    return {"mode": mode, "items": [_media_out(m) for m in rows]}


@router.get("/media/{media_id}", dependencies=[Depends(require_token)])
def get_media(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    return _media_out(m)


@router.get("/media/{media_id}/file", dependencies=[Depends(require_token)])
def media_file(media_id: int, db=Depends(get_db)):
    """
    Stream media with Range support (native <video> on mobile).
    Auth: header or ?token= (see require_token).
    """
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    path = get_settings().medias_path() / m.rel_path
    if not path.is_file():
        raise HTTPException(404, "File missing on disk")
    media = m.mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    # webm leftovers: still serve, but prefer correct type for mp4 after remux
    if path.suffix.lower() == ".mp4":
        media = "video/mp4"
    elif path.suffix.lower() == ".webm":
        media = "video/webm"
    return FileResponse(
        path,
        media_type=media,
        filename=path.name,
        content_disposition_type="inline",
    )


@router.get("/media/{media_id}/thumb", dependencies=[Depends(require_token)])
def media_thumb(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    tpath = thumb_path_for(media_id)
    if not tpath.is_file():
        src = get_settings().medias_path() / m.rel_path
        if src.is_file():
            rel = generate_thumb(src, media_id, m.media_type)
            if rel:
                m.thumb_rel = rel
                db.commit()
    if tpath.is_file():
        return FileResponse(tpath, media_type="image/jpeg")
    # 1x1 pixel jpeg fallback is better as SVG placeholder via empty 404 with cache
    raise HTTPException(404, "No thumb")


@router.delete("/media/{media_id}", dependencies=[Depends(require_token)])
def delete_media(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    path = get_settings().medias_path() / m.rel_path
    if path.is_file():
        path.unlink(missing_ok=True)
    tpath = thumb_path_for(media_id)
    tpath.unlink(missing_ok=True)
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.post("/media/{media_id}/like", dependencies=[Depends(require_token)])
def toggle_like(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    m.liked = not bool(m.liked)
    m.like_count = 1 if m.liked else 0
    db.commit()
    db.refresh(m)
    return _media_out(m)


@router.post("/media/{media_id}/interact", dependencies=[Depends(require_token)])
def interact(media_id: int, body: InteractEvent, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    ev = (body.event or "view").lower()
    now = datetime.now(timezone.utc)
    if ev == "view":
        m.view_count = int(m.view_count or 0) + 1
        m.last_viewed_at = now
    elif ev == "dwell":
        ms = max(0, min(int(body.dwell_ms or 0), 600_000))
        m.dwell_ms_total = int(m.dwell_ms_total or 0) + ms
        m.last_viewed_at = now
        if ms >= 1500 and int(m.view_count or 0) == 0:
            m.view_count = 1
    elif ev == "skip":
        m.skip_count = int(m.skip_count or 0) + 1
        m.last_viewed_at = now
    else:
        raise HTTPException(400, "event must be view|dwell|skip")
    db.commit()
    db.refresh(m)
    return _media_out(m)


@router.post("/ingest", dependencies=[Depends(require_token)])
async def ingest(body: IngestRequest):
    result = await enqueue_jobs(
        body.category,
        [it.model_dump() for it in body.items],
    )
    return result


@router.post("/upload", dependencies=[Depends(require_token)])
async def upload(
    category: str = Form("default"),
    title: str = Form(""),
    source_url: str = Form(""),
    media_type: str = Form(""),
    remux: str = Form("1"),
    file: UploadFile = File(...),
):
    """
    Direct blob upload (cache capture / recorder).
    Default remux=1 runs ffmpeg copy+faststart so MSE fMP4 / webm is browser-playable.
    """
    cat = ensure_category(category)
    settings = get_settings()
    raw_name = file.filename or "upload.bin"
    data = await file.read()
    if settings.max_file_bytes and len(data) > settings.max_file_bytes:
        raise HTTPException(400, "File too large")
    ext = Path(raw_name).suffix.lstrip(".") or "bin"
    mtype = media_type or detect_media_type(raw_name, file.content_type, None)
    if mtype == "m3u8":
        mtype = "video"
    if mtype not in ("image", "gif", "video"):
        mtype = "video"
    fname = safe_filename(title or Path(raw_name).stem, source_url or raw_name, ext)
    dest = settings.medias_path() / cat / fname
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    mime = file.content_type or ""
    note = ""
    if remux not in ("0", "false", "False") and mtype == "video":
        try:
            dest2 = remux_to_playable(dest, prefer_ext=ext)
            if dest2 != dest:
                dest = dest2
                note = "remuxed"
            mime = mimetypes.guess_type(dest.name)[0] or mime or "video/mp4"
        except Exception as e:
            note = f"remux_skip:{e}"
    item = register_uploaded_file(
        category=cat,
        dest=dest,
        title=title or Path(raw_name).stem,
        source_url=source_url,
        media_type=mtype,
        mime=mime,
        dedupe=False,
    )
    return {"media_id": item.id, "item": _media_out(item), "note": note}


@router.post("/upload-av", dependencies=[Depends(require_token)])
async def upload_av(
    category: str = Form("default"),
    title: str = Form(""),
    source_url: str = Form(""),
    video: UploadFile = File(...),
    audio: UploadFile | None = File(None),
):
    """
    Merge separate MSE video + audio buffers into one playable mp4 (one media item).
    """
    cat = ensure_category(category)
    settings = get_settings()
    vdata = await video.read()
    adata = await audio.read() if audio is not None else b""
    if settings.max_file_bytes and (len(vdata) + len(adata)) > settings.max_file_bytes:
        raise HTTPException(400, "File too large")
    if len(vdata) < 32:
        raise HTTPException(400, "Empty video track")

    v_tmp = write_temp_bytes(vdata, ".mp4")
    a_tmp = write_temp_bytes(adata, ".mp4") if adata and len(adata) > 32 else None
    try:
        fname = safe_filename(title or "capture", source_url or "capture", "mp4")
        dest = settings.medias_path() / cat / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            merge_av_to_mp4(v_tmp, a_tmp, dest)
            note = "merged"
        except Exception as e:
            # fallback: remux video track only
            dest.write_bytes(vdata)
            dest = remux_to_playable(dest, prefer_ext="mp4")
            note = f"video_only:{e}"
        item = register_uploaded_file(
            category=cat,
            dest=dest,
            title=title or "capture",
            source_url=source_url,
            media_type="video",
            mime="video/mp4",
            dedupe=False,
        )
        return {"media_id": item.id, "item": _media_out(item), "note": note}
    finally:
        for p in (v_tmp, a_tmp):
            if p and p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass


@router.get("/jobs", dependencies=[Depends(require_token)])
def list_jobs(
    status: str | None = None,
    limit: int = Query(default=50, le=200),
    db=Depends(get_db),
):
    stmt = select(DownloadJob).order_by(desc(DownloadJob.id)).limit(limit)
    if status:
        stmt = select(DownloadJob).where(DownloadJob.status == status).order_by(desc(DownloadJob.id)).limit(limit)
    rows = db.scalars(stmt).all()
    return {"items": [_job_out(j) for j in rows]}


@router.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
def get_job(job_id: int, db=Depends(get_db)):
    j = db.get(DownloadJob, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    return _job_out(j)


@router.post("/jobs/{job_id}/retry", dependencies=[Depends(require_token)])
def retry_job(job_id: int, db=Depends(get_db)):
    j = db.get(DownloadJob, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    j.status = "queued"
    j.error_message = ""
    j.progress = 0
    db.commit()
    return _job_out(j)


@router.post("/jobs/{job_id}/cancel", dependencies=[Depends(require_token)])
def cancel_job(job_id: int, db=Depends(get_db)):
    j = db.get(DownloadJob, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    if j.status in ("queued", "running"):
        request_cancel(job_id)
        j.status = "cancelled"
        j.error_message = "Cancelled"
        db.commit()
    return _job_out(j)


@router.post("/rescan", dependencies=[Depends(require_token)])
def rescan(purge: bool = Query(default=False)):
    """Scan Medias disk → DB. purge=1 also drops rows whose files are gone."""
    return rescan_medias(purge=purge)


@router.post("/refresh-library", dependencies=[Depends(require_token)])
def refresh_library():
    """
    Force refresh: purge missing/deleted files from DB, remove orphan thumbs,
    then re-scan Medias for new files.
    """
    return rescan_medias(purge=True)


@router.post("/purge-missing", dependencies=[Depends(require_token)])
def purge_missing():
    return purge_missing_media()
