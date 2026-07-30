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

from app.api.schemas import (
    CategoryCreate,
    IngestRequest,
    InteractEvent,
    JasnaJobOut,
    JobOut,
    MediaDeleteBatch,
    MediaJasnaBatch,
    MediaOut,
    MediaPatch,
    TagSuggestRequest,
    TagsBatchUpdate,
    TagsUpdate,
)
from app.core.config import (
    ffmpeg_available,
    get_settings,
    gopeed_binary_available,
    jasna_binary_available,
)
from app.core.db import get_db
from app.models.entities import DownloadJob, JasnaJob, MediaItem
from app.services.download import enqueue_jobs, register_uploaded_file, request_cancel
from app.services.jasna import enqueue_jasna_for_media, request_cancel as jasna_request_cancel
from app.services.feed_rank import (
    FeedRankParams,
    diversify_sequence,
    rank_by_tag,
    rank_recommend_with_affinity,
    rank_similar,
)
from app.services.media_process import merge_av_to_mp4, remux_to_playable, write_temp_bytes
from app.services.scan import ensure_category, list_categories, purge_missing_media, rescan_medias
from app.services.tags import (
    RESTRICTED_TAG,
    apply_restricted_flag,
    canonical_tag,
    collect_tag_counts,
    match_library_tags,
    near_duplicate_tag,
    normalize_tags,
    set_restricted_flag,
    suggest_tags,
    tags_from_json,
    tags_to_json,
)
from app.services.thumb import generate_thumb, thumb_path_for
from app.services.util import detect_media_type, safe_filename

router = APIRouter(prefix="/api")
public_router = APIRouter(prefix="/api")


def _media_cache_ver(m: MediaItem) -> str:
    """Bust client/browser caches after jasna replace or re-encode (same id URL)."""
    ts = getattr(m, "updated_at", None) or getattr(m, "created_at", None)
    try:
        t = int(ts.timestamp()) if ts is not None else 0
    except Exception:
        t = 0
    size = int(getattr(m, "file_size", 0) or 0)
    return f"{size}-{t}"


def _media_out(m: MediaItem) -> MediaOut:
    ver = _media_cache_ver(m)
    return MediaOut(
        id=m.id,
        category=getattr(m, "category", None) or "default",
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
        tags=tags_from_json(getattr(m, "tags_json", None)),
        created_at=m.created_at,
        # ?v= changes after demosaic / re-encode so blob cache + browser revalidate
        file_url=f"/api/media/{m.id}/file?v={ver}",
        thumb_url=f"/api/media/{m.id}/thumb?v={ver}",
    )


def _job_out(j: DownloadJob) -> JobOut:
    return JobOut(
        id=j.id,
        category=getattr(j, "category", None) or "default",
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
        tags=tags_from_json(getattr(j, "tags_json", None)),
        use_jasna=bool(getattr(j, "use_jasna", False)),
        created_at=j.created_at,
    )


def _jasna_job_out(j: JasnaJob) -> JasnaJobOut:
    return JasnaJobOut(
        id=j.id,
        media_id=j.media_id,
        status=j.status,
        progress=float(j.progress or 0),
        error_message=j.error_message or "",
        input_path=j.input_path or "",
        output_path=j.output_path or "",
        created_at=j.created_at,
        updated_at=j.updated_at,
    )


def _flag_true(v: str | bool | None) -> bool:
    if v is True:
        return True
    if v is False or v is None:
        return False
    return str(v).strip().lower() in ("1", "true", "yes", "on")


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
        "jasna": bool(getattr(s, "jasna_enabled", True)) and jasna_binary_available(),
        "jasna_enabled": bool(getattr(s, "jasna_enabled", True)),
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
    """Deprecated: categories removed; always default."""
    return {"categories": list_categories()}


@router.post("/categories", dependencies=[Depends(require_token)])
def create_category(body: CategoryCreate):
    """Deprecated no-op."""
    name = ensure_category(body.name)
    return {"name": name, "deprecated": True}


def _all_tag_counts(db) -> dict[str, int]:
    """Aggregate tag frequency from entire media library (tag library view)."""
    lists = [
        tags_from_json(getattr(m, "tags_json", None))
        for m in db.scalars(select(MediaItem)).all()
    ]
    return collect_tag_counts(lists)


@router.get("/tags", dependencies=[Depends(require_token)])
def list_tags(
    q: str = Query("", description="optional filter prefix/contains"),
    limit: int = Query(0, ge=0, le=5000, description="0 = all"),
    db=Depends(get_db),
):
    counts = _all_tag_counts(db)
    items = [{"name": k, "count": v} for k, v in counts.items()]
    items.sort(key=lambda x: (-x["count"], x["name"]))
    query = (q or "").strip().lower().lstrip("#")
    if query:
        items = [
            t
            for t in items
            if query in t["name"] or t["name"].startswith(query)
        ]
    if limit and limit > 0:
        items = items[:limit]
    return {"tags": items, "total": len(counts)}


@router.post("/tags/suggest", dependencies=[Depends(require_token)])
def tags_suggest(body: TagSuggestRequest, db=Depends(get_db)):
    counts = _all_tag_counts(db)
    # Prefer full library; also keep a recent pool for any uncounted edge cases
    pool = list(counts.keys())
    lim = max(1, min(int(body.limit or 12), 32))
    tags = suggest_tags(
        title=body.title,
        url=body.url,
        media_type=body.media_type,
        source_page=body.source_page,
        existing_pool=pool,
        tag_counts=counts,
        limit=lim,
    )
    matches: list[dict] = []
    if (body.query or "").strip():
        matches = match_library_tags(body.query, counts, limit=min(12, lim))
    # Soft corrections for free-typed tokens in title (optional hint list)
    near: list[dict] = []
    for tok in (body.title or "").replace(",", " ").split()[:8]:
        nd = near_duplicate_tag(tok, counts, min_count=2)
        if nd:
            near.append({"from": canonical_tag(tok), "to": nd, "count": counts.get(nd, 0)})
    return {
        "tags": tags,
        "matches": matches,
        "near": near,
        "library_size": len(counts),
    }


@router.post("/media/{media_id}/tags", dependencies=[Depends(require_token)])
def set_media_tags(media_id: int, body: TagsUpdate, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    m.tags_json = tags_to_json(body.tags)
    db.commit()
    db.refresh(m)
    return _media_out(m)


@router.post("/media/tags/batch", dependencies=[Depends(require_token)])
def batch_media_tags(body: TagsBatchUpdate, db=Depends(get_db)):
    if not body.ids:
        raise HTTPException(400, "ids required")
    new_tags = normalize_tags(body.tags)
    updated = 0
    items = []
    for mid in body.ids[:200]:
        m = db.get(MediaItem, mid)
        if not m:
            continue
        if body.mode == "replace":
            m.tags_json = tags_to_json(new_tags)
        else:
            merged = normalize_tags(tags_from_json(m.tags_json) + new_tags)
            m.tags_json = tags_to_json(merged)
        updated += 1
        items.append(_media_out(m))
    db.commit()
    return {"updated": updated, "items": items}


def _exclude_restricted_sql():
    """SQL filter: items that do NOT carry the 限制级 tag."""
    needle = f'%"{RESTRICTED_TAG}"%'
    return ~MediaItem.tags_json.like(needle)


@router.get("/media", dependencies=[Depends(require_token)])
def list_media(
    type: str | None = None,
    q: str | None = None,
    tag: str | None = None,
    liked: bool | None = None,
    sort: str = "new",
    # True: include 限制级; False: hide them. Default True for manage UIs.
    include_restricted: bool = True,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=48, ge=1, le=100),
    db=Depends(get_db),
):
    """
    Paginated media list with server-side filters (no full-table materialization).
    tag: matches tags_json containing the canonical tag string (JSON array storage).
    include_restricted: when False, hide items tagged 限制级.
    """
    filters = []
    if type:
        filters.append(MediaItem.media_type == type)
    if q:
        # title / source_url / tags（JSON 文本子串，支持部分标签匹配）
        qq = q.strip().lstrip("#")
        if qq:
            # escape LIKE wildcards so user input is literal
            safe = qq.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            safe_l = safe.lower()
            like = f"%{safe}%"
            like_l = f"%{safe_l}%"
            filters.append(
                MediaItem.title.contains(qq)
                | MediaItem.source_url.contains(qq)
                | MediaItem.tags_json.like(like, escape="\\")
                | MediaItem.tags_json.like(like_l, escape="\\")
            )
    if liked is True:
        filters.append(MediaItem.liked.is_(True))
    elif liked is False:
        filters.append(MediaItem.liked.is_(False))
    if tag:
        t = canonical_tag(tag)
        if t:
            # tags stored as JSON array of canonical lower-case names, e.g. ["video","anime"]
            filters.append(MediaItem.tags_json.like(f'%"{t}"%'))
    if not include_restricted:
        filters.append(_exclude_restricted_sql())

    count_stmt = select(func.count()).select_from(MediaItem)
    list_stmt = select(MediaItem)
    for f in filters:
        count_stmt = count_stmt.where(f)
        list_stmt = list_stmt.where(f)

    if sort == "old":
        list_stmt = list_stmt.order_by(MediaItem.id.asc())
    else:
        list_stmt = list_stmt.order_by(MediaItem.id.desc())

    total = int(db.scalar(count_stmt) or 0)
    page = list(db.scalars(list_stmt.offset(offset).limit(limit)).all())
    return {"total": total, "offset": offset, "limit": limit, "items": [_media_out(m) for m in page]}


def _parse_id_set(raw: str | None) -> set[int]:
    out: set[int] = set()
    if not raw:
        return out
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.add(int(part))
        except ValueError:
            continue
    return out


@router.get("/feed", dependencies=[Depends(require_token)])
def feed(
    mode: str = "recommend",
    limit: int = Query(default=30, le=100),
    similar_to: int | None = None,
    tag: str | None = None,
    exclude_ids: str | None = None,
    include_seed: bool = True,
    # Default False: do not push 限制级 content unless client opts in
    include_restricted: bool = False,
    db=Depends(get_db),
):
    """
    mode:
      - recommend: multi-channel (interest/fresh/explore/revisit) + fatigue + diversity
      - similar: similar_to media_id (tag overlap), or tag= focus tag
      - recent: created_at then id desc (true ingest order)
      - random: full-library SQL RANDOM sample + light anti-clump
      - liked

    exclude_ids: comma-separated media ids already in the client playlist
    (for on-demand next batches without repeating).
    include_seed: when similar by media, put seed first (false for tail prefetch).
    tag: when mode=similar (or alone with similar), rank by that tag.
    include_restricted: when False (default), hide items tagged 限制级.
    """
    exclude = _parse_id_set(exclude_ids)
    # over-fetch then filter so exclude does not shrink the page too much
    fetch_n = min(500, max(limit * 4, limit + len(exclude) + 20))
    focus_tag = canonical_tag(tag) if tag else ""
    settings = get_settings()

    stmt = select(MediaItem)
    if not include_restricted:
        stmt = stmt.where(_exclude_restricted_sql())
    if mode == "liked":
        stmt = stmt.where(MediaItem.liked.is_(True))
        rows = list(
            db.scalars(
                stmt.order_by(desc(MediaItem.created_at), desc(MediaItem.id)).limit(fetch_n)
            ).all()
        )
    elif mode == "recent":
        # True "latest": created_at first (not only autoincrement id — rescan/import safe)
        rows = list(
            db.scalars(
                stmt.order_by(desc(MediaItem.created_at), desc(MediaItem.id)).limit(fetch_n)
            ).all()
        )
    elif mode == "random":
        # True full-library random (not "latest N then shuffle").
        pool_mult = max(1, int(getattr(settings, "feed_random_pool_mult", 3) or 3))
        sample_n = min(800, max(limit * pool_mult, limit + len(exclude) + 10))
        q = stmt
        if exclude:
            q = q.where(~MediaItem.id.in_(list(exclude)))
        # SQLite: RANDOM(); other dialects: func.random()
        rows = list(
            db.scalars(q.order_by(func.random()).limit(sample_n)).all()
        )
        if not rows and exclude:
            # fallback if exclude wiped the pool (tiny library)
            rows = list(db.scalars(stmt.order_by(func.random()).limit(sample_n)).all())
        random.shuffle(rows)
        rows = diversify_sequence(rows, limit=min(limit, len(rows)))
        # already excluded in SQL when possible; skip post-filter for this branch
        return {
            "mode": mode,
            "similar_to": similar_to,
            "tag": focus_tag or None,
            "items": [_media_out(m) for m in rows[:limit]],
        }
    elif mode == "similar" or similar_to:
        pool = list(
            db.scalars(stmt.order_by(desc(MediaItem.id)).limit(800)).all()
        )
        if focus_tag:
            # Tag-focused similar: must carry this tag
            ranked = rank_by_tag(
                pool,
                focus_tag,
                limit=min(200, fetch_n),
            )
            rows = ranked
        else:
            seed = db.get(MediaItem, similar_to) if similar_to else None
            if seed is None and pool:
                seed = pool[0]
            if seed is None:
                rows = []
            else:
                ranked = rank_similar(pool, seed, limit=min(200, fetch_n))
                if not include_seed:
                    ranked = [m for m in ranked if m.id != seed.id]
                rows = ranked
        mode = "similar"
    else:
        # Mixed candidate pool: recent + random long-tail (mainstream multi-channel input)
        n_recent = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_recent", 250) or 250),
        )
        n_rand = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_random", 250) or 250),
        )
        recent_rows = list(
            db.scalars(stmt.order_by(desc(MediaItem.id)).limit(n_recent)).all()
        )
        rand_rows = list(
            db.scalars(stmt.order_by(func.random()).limit(n_rand)).all()
        )
        by_id: dict[int, MediaItem] = {}
        for m in recent_rows + rand_rows:
            by_id[int(m.id)] = m
        pool = list(by_id.values())
        params = FeedRankParams.from_settings(settings)
        rows = rank_recommend_with_affinity(
            pool, limit=min(200, fetch_n), params=params
        )
    if exclude:
        rows = [m for m in rows if m.id not in exclude]
    rows = rows[:limit]
    return {
        "mode": mode,
        "similar_to": similar_to,
        "tag": focus_tag or None,
        "items": [_media_out(m) for m in rows],
    }

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
    try:
        st = path.stat()
        etag = f'"{st.st_mtime_ns}-{st.st_size}"'
    except OSError:
        etag = f'"{m.id}-{m.file_size or 0}"'
    return FileResponse(
        path,
        media_type=media,
        filename=path.name,
        content_disposition_type="inline",
        headers={
            "Cache-Control": "private, max-age=0, must-revalidate",
            "ETag": etag,
        },
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
        try:
            st = tpath.stat()
            etag = f'"{st.st_mtime_ns}-{st.st_size}"'
        except OSError:
            etag = f'"thumb-{media_id}"'
        return FileResponse(
            tpath,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "private, max-age=0, must-revalidate",
                "ETag": etag,
            },
        )
    # 1x1 pixel jpeg fallback is better as SVG placeholder via empty 404 with cache
    raise HTTPException(404, "No thumb")


def _delete_media_row(db, m: MediaItem) -> None:
    """Remove media file, thumb, and DB row (caller commits)."""
    path = get_settings().medias_path() / m.rel_path
    if path.is_file():
        path.unlink(missing_ok=True)
    tpath = thumb_path_for(m.id)
    tpath.unlink(missing_ok=True)
    db.delete(m)


@router.delete("/media/{media_id}", dependencies=[Depends(require_token)])
def delete_media(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    _delete_media_row(db, m)
    db.commit()
    return {"ok": True}


@router.post("/media/delete-batch", dependencies=[Depends(require_token)])
def delete_media_batch(body: MediaDeleteBatch, db=Depends(get_db)):
    if not body.ids:
        raise HTTPException(400, "ids required")
    deleted: list[int] = []
    for mid in body.ids[:200]:
        m = db.get(MediaItem, mid)
        if not m:
            continue
        _delete_media_row(db, m)
        deleted.append(mid)
    db.commit()
    return {"deleted": len(deleted), "ids": deleted}


@router.patch("/media/{media_id}", dependencies=[Depends(require_token)])
def patch_media(media_id: int, body: MediaPatch, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    if body.title is not None:
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(400, "title empty")
        m.title = title[:500]
    if body.tags is not None:
        m.tags_json = tags_to_json(body.tags)
    if body.restricted is not None:
        cur = tags_from_json(m.tags_json)
        m.tags_json = tags_to_json(set_restricted_flag(cur, bool(body.restricted)))
    db.commit()
    db.refresh(m)
    return _media_out(m)


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
    items = []
    default_tags = apply_restricted_flag(body.tags, body.restricted)
    for it in body.items:
        d = it.model_dump()
        if body.use_jasna and not d.get("use_jasna"):
            d["use_jasna"] = True
        item_restricted = bool(d.pop("restricted", False) or body.restricted)
        raw = d.get("tags") or body.tags or []
        d["tags"] = apply_restricted_flag(raw, item_restricted)
        items.append(d)
    result = await enqueue_jobs(
        "default",
        items,
        default_tags=default_tags,
    )
    return result


@router.post("/upload", dependencies=[Depends(require_token)])
async def upload(
    category: str = Form("default"),
    title: str = Form(""),
    source_url: str = Form(""),
    media_type: str = Form(""),
    remux: str = Form("1"),
    tags: str = Form(""),
    use_jasna: str = Form("0"),
    restricted: str = Form("0"),
    file: UploadFile = File(...),
):
    """
    Direct blob upload (cache capture / recorder / extension manage page).
    Default remux=1 runs ffmpeg copy+faststart so MSE fMP4 / webm is browser-playable.
    tags: JSON array or comma-separated (unlimited count; deduped/normalized).
    restricted=1 adds the 限制级 tag.
    Streams to disk in chunks (avoids loading multi-GB files into RAM).
    """
    ensure_category(category)
    settings = get_settings()
    raw_name = file.filename or "upload.bin"
    ext = Path(raw_name).suffix.lstrip(".") or "bin"
    mtype = media_type or detect_media_type(raw_name, file.content_type, None)
    if mtype == "m3u8":
        mtype = "video"
    if mtype not in ("image", "gif", "video", "audio"):
        mtype = "video"
    fname = safe_filename(title or Path(raw_name).stem, source_url or raw_name, ext)
    dest = settings.medias_path() / fname
    dest.parent.mkdir(parents=True, exist_ok=True)
    max_bytes = int(settings.max_file_bytes or 0)
    written = 0
    chunk_size = 1024 * 1024
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                written += len(chunk)
                if max_bytes and written > max_bytes:
                    raise HTTPException(400, "File too large")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    if written < 1:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "Empty file")
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
    tag_list = apply_restricted_flag(tags, _flag_true(restricted))
    item = register_uploaded_file(
        category="default",
        dest=dest,
        title=title or Path(raw_name).stem,
        source_url=source_url,
        media_type=mtype,
        mime=mime,
        dedupe=False,
        tags=tag_list,
    )
    jasna_job_id = None
    if _flag_true(use_jasna) and mtype == "video":
        jasna_job_id = enqueue_jasna_for_media(item.id)
    return {
        "media_id": item.id,
        "item": _media_out(item),
        "note": note,
        "jasna_job_id": jasna_job_id,
    }


@router.post("/upload-av", dependencies=[Depends(require_token)])
async def upload_av(
    category: str = Form("default"),
    title: str = Form(""),
    source_url: str = Form(""),
    tags: str = Form(""),
    use_jasna: str = Form("0"),
    restricted: str = Form("0"),
    video: UploadFile = File(...),
    audio: UploadFile | None = File(None),
):
    """
    Merge separate MSE video + audio buffers into one playable mp4 (one media item).
    """
    ensure_category(category)
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
        dest = settings.medias_path() / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            merge_av_to_mp4(v_tmp, a_tmp, dest)
            note = "merged"
        except Exception as e:
            dest.write_bytes(vdata)
            dest = remux_to_playable(dest, prefer_ext="mp4")
            note = f"video_only:{e}"
        item = register_uploaded_file(
            category="default",
            dest=dest,
            title=title or "capture",
            source_url=source_url,
            media_type="video",
            mime="video/mp4",
            dedupe=False,
            tags=apply_restricted_flag(tags, _flag_true(restricted)),
        )
        jasna_job_id = None
        if _flag_true(use_jasna):
            jasna_job_id = enqueue_jasna_for_media(item.id)
        return {
            "media_id": item.id,
            "item": _media_out(item),
            "note": note,
            "jasna_job_id": jasna_job_id,
        }
    finally:
        for p in (v_tmp, a_tmp):
            if p and p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass


@router.get("/jasna/jobs", dependencies=[Depends(require_token)])
def list_jasna_jobs(
    status: str | None = None,
    media_id: int | None = None,
    limit: int = Query(default=50, le=200),
    db=Depends(get_db),
):
    stmt = select(JasnaJob).order_by(desc(JasnaJob.id)).limit(limit)
    if status:
        stmt = (
            select(JasnaJob)
            .where(JasnaJob.status == status)
            .order_by(desc(JasnaJob.id))
            .limit(limit)
        )
    if media_id is not None:
        stmt = (
            select(JasnaJob)
            .where(JasnaJob.media_id == media_id)
            .order_by(desc(JasnaJob.id))
            .limit(limit)
        )
        if status:
            stmt = (
                select(JasnaJob)
                .where(JasnaJob.media_id == media_id, JasnaJob.status == status)
                .order_by(desc(JasnaJob.id))
                .limit(limit)
            )
    rows = db.scalars(stmt).all()
    return {"items": [_jasna_job_out(j) for j in rows]}


@router.get("/jasna/jobs/{job_id}", dependencies=[Depends(require_token)])
def get_jasna_job(job_id: int, db=Depends(get_db)):
    j = db.get(JasnaJob, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    return _jasna_job_out(j)


@router.post("/jasna/jobs/{job_id}/cancel", dependencies=[Depends(require_token)])
def cancel_jasna_job(job_id: int, db=Depends(get_db)):
    j = db.get(JasnaJob, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    if j.status in ("success", "failed", "cancelled"):
        return _jasna_job_out(j)
    jasna_request_cancel(job_id)
    if j.status == "queued":
        j.status = "cancelled"
        j.error_message = "Cancelled"
        db.commit()
        db.refresh(j)
    return _jasna_job_out(j)


@router.post("/media/{media_id}/jasna", dependencies=[Depends(require_token)])
def media_enqueue_jasna(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    jid = enqueue_jasna_for_media(media_id, force=False)
    if jid is None:
        raise HTTPException(400, "Cannot enqueue jasna (not video, missing file, or jasna unavailable)")
    j = db.get(JasnaJob, jid)
    return {"jasna_job_id": jid, "job": _jasna_job_out(j) if j else None}


@router.post("/media/jasna-batch", dependencies=[Depends(require_token)])
def media_enqueue_jasna_batch(body: MediaJasnaBatch, db=Depends(get_db)):
    """Queue jasna demosaic for multiple media items (serial GPU worker)."""
    if not body.ids:
        raise HTTPException(400, "ids required")
    queued: list[dict] = []
    skipped: list[dict] = []
    for mid in body.ids[:200]:
        m = db.get(MediaItem, mid)
        if not m:
            skipped.append({"id": mid, "reason": "not_found"})
            continue
        jid = enqueue_jasna_for_media(int(mid), force=bool(body.force))
        if jid is None:
            mtype = (m.media_type or "").lower()
            reason = "not_video" if mtype not in ("video", "m3u8") else "unavailable_or_skipped"
            skipped.append({"id": mid, "reason": reason, "media_type": mtype})
            continue
        j = db.get(JasnaJob, jid)
        queued.append(
            {
                "id": mid,
                "jasna_job_id": jid,
                "job": _jasna_job_out(j) if j else None,
            }
        )
    return {
        "queued": len(queued),
        "skipped": len(skipped),
        "items": queued,
        "skipped_items": skipped,
    }


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
