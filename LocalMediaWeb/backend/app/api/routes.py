from __future__ import annotations

import logging
import math
import mimetypes
import random
import re
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import asc, desc, func, select, text

logger = logging.getLogger("lmw.api")

from app.api.deps import require_token
from datetime import datetime, timezone

from app.api.schemas import (
    AvMatchRequest,
    AvMergeRequest,
    CategoryCreate,
    DlnaControlRequest,
    DlnaPlayRequest,
    DlnaSeekRequest,
    FeedRequest,
    IngestRequest,
    InteractEvent,
    JasnaJobOut,
    JobOut,
    MediaConcatRequest,
    MediaDeleteBatch,
    MediaDedupeRequest,
    MediaJasnaBatch,
    MediaOut,
    MediaPatch,
    MediaReclassifyRequest,
    ProbeUrlRequest,
    SeriesCreate,
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
from app.models.entities import DownloadJob, JasnaJob, MediaItem, MediaSeries, SeriesEpisode
from app.services.dedupe import dedupe_identical_media
from app.services.download import enqueue_jobs, register_uploaded_file, request_cancel
from app.services.jasna import enqueue_jasna_for_media, request_cancel as jasna_request_cancel
from app.services.feed_rank import (
    FeedRankParams,
    diversify_sequence,
    rank_by_tag,
    rank_recommend_with_affinity,
    rank_similar,
)
from app.services.media_process import (
    classify_media_file,
    concat_videos_to_mp4,
    match_av_by_duration,
    merge_av_to_mp4,
    probe_single_file_role,
    remux_to_playable,
    write_temp_bytes,
)
from app.services.reencode import ReencodeError, reencode_replace_h264
from app.services.replace_file import ReplaceFileError, replace_library_video
from app.services.subtitle_store import (
    SubtitleStoreError,
    delete_subtitle,
    has_subtitle,
    read_srt,
    subtitle_rev,
    save_srt,
    srt_to_vtt,
)
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
from app.services.util import detect_media_type, ensure_unique_path, safe_filename

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


def _series_info_by_media(db, media_ids: list[int]) -> dict[int, dict]:
    """media_id -> series fields for MediaOut."""
    ids = [int(i) for i in media_ids if i is not None]
    if not ids:
        return {}
    eps = list(db.scalars(select(SeriesEpisode).where(SeriesEpisode.media_id.in_(ids))).all())
    if not eps:
        return {}
    sids = list({int(e.series_id) for e in eps})
    series_rows = list(db.scalars(select(MediaSeries).where(MediaSeries.id.in_(sids))).all())
    series_by_id = {int(s.id): s for s in series_rows}
    counts: dict[int, int] = {}
    for sid in sids:
        n = db.scalar(
            select(func.count()).select_from(SeriesEpisode).where(SeriesEpisode.series_id == sid)
        )
        counts[sid] = int(n or 0)
    out: dict[int, dict] = {}
    for e in eps:
        s = series_by_id.get(int(e.series_id))
        out[int(e.media_id)] = {
            "series_id": int(e.series_id),
            "series_title": (s.title if s else "") or "",
            "episode_index": int(e.episode_index),
            "episode_count": counts.get(int(e.series_id), 0),
            "series_current_index": int(s.current_episode_index) if s else int(e.episode_index),
        }
    return out


def _media_out(m: MediaItem, series: dict | None = None) -> MediaOut:
    ver = _media_cache_ver(m)
    series = series or {}
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
        duration_sec=(
            float(m.duration_sec)
            if getattr(m, "duration_sec", None) is not None
            else None
        ),
        max_progress=float(getattr(m, "max_progress", 0) or 0),
        last_position_sec=float(getattr(m, "last_position_sec", 0) or 0),
        tags=tags_from_json(getattr(m, "tags_json", None)),
        review=getattr(m, "review", None) or "",
        created_at=m.created_at,
        # ?v= changes after demosaic / re-encode so blob cache + browser revalidate
        file_url=f"/api/media/{m.id}/file?v={ver}",
        thumb_url=f"/api/media/{m.id}/thumb?v={ver}",
        has_subtitle=has_subtitle(int(m.id)),
        subtitle_rev=subtitle_rev(int(m.id)),
        series_id=series.get("series_id"),
        series_title=series.get("series_title") or "",
        episode_index=series.get("episode_index"),
        episode_count=series.get("episode_count"),
        series_current_index=series.get("series_current_index"),
    )


def _media_outs(db, rows: list) -> list[MediaOut]:
    infos = _series_info_by_media(db, [int(m.id) for m in rows])
    return [_media_out(m, infos.get(int(m.id))) for m in rows]


def _media_out_one(db, m: MediaItem) -> MediaOut:
    infos = _series_info_by_media(db, [int(m.id)])
    return _media_out(m, infos.get(int(m.id)))


def _detach_media_from_series(db, media_id: int) -> None:
    ep = db.scalar(select(SeriesEpisode).where(SeriesEpisode.media_id == int(media_id)))
    if not ep:
        return
    sid = int(ep.series_id)
    db.delete(ep)
    db.flush()
    rest = list(
        db.scalars(
            select(SeriesEpisode)
            .where(SeriesEpisode.series_id == sid)
            .order_by(SeriesEpisode.episode_index.asc())
        ).all()
    )
    if len(rest) < 2:
        for r in rest:
            db.delete(r)
        s = db.get(MediaSeries, sid)
        if s:
            db.delete(s)
        return
    for i, r in enumerate(rest, start=1):
        r.episode_index = i
    s = db.get(MediaSeries, sid)
    if s and int(s.current_media_id or 0) == int(media_id):
        s.current_media_id = int(rest[0].media_id)
        s.current_episode_index = 1


def _touch_series_cursor(db, m: MediaItem) -> None:
    ep = db.scalar(select(SeriesEpisode).where(SeriesEpisode.media_id == int(m.id)))
    if not ep:
        return
    s = db.get(MediaSeries, int(ep.series_id))
    if not s:
        return
    s.current_media_id = int(m.id)
    s.current_episode_index = int(ep.episode_index)


def _series_episodes_out(db, series: MediaSeries) -> list[MediaOut]:
    eps = list(
        db.scalars(
            select(SeriesEpisode)
            .where(SeriesEpisode.series_id == int(series.id))
            .order_by(SeriesEpisode.episode_index.asc())
        ).all()
    )
    ids = [int(e.media_id) for e in eps]
    rows = _load_media_in_order(db, ids)
    infos = _series_info_by_media(db, [int(m.id) for m in rows])
    return [_media_out(m, infos.get(int(m.id))) for m in rows]


def _series_representative(db, series: MediaSeries) -> MediaItem | None:
    mid = int(series.current_media_id or 0)
    if mid:
        m = db.get(MediaItem, mid)
        if m:
            return m
    ep = db.scalar(
        select(SeriesEpisode)
        .where(SeriesEpisode.series_id == int(series.id))
        .order_by(SeriesEpisode.episode_index.asc())
        .limit(1)
    )
    if not ep:
        return None
    return db.get(MediaItem, int(ep.media_id))


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


def _parse_tag_list(raw) -> list[str]:
    """Comma-separated tag names as stored (no synonym aliases)."""
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        parts = [str(x) for x in raw]
    else:
        parts = str(raw).replace("，", ",").replace("；", ",").replace(";", ",").split(",")
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        t = str(p or "").strip().lower().lstrip("#")
        t = re.sub(r"\s+", "-", t)
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _exclude_tags_clauses(names: list[str]):
    """Hide rows whose tags_json JSON array contains an exact tag string.

    Uses json_each (not LIKE): empty/NULL tags stay visible; substring / alias
    tags are not treated as a match.
    """
    clauses = []
    for i, t in enumerate(names or []):
        if not t:
            continue
        key = f"excl_tag_{i}"
        clauses.append(
            text(
                "NOT EXISTS ("
                "SELECT 1 FROM json_each(COALESCE(media_items.tags_json, '[]')) "
                f"WHERE CAST(json_each.value AS TEXT) = :{key}"
                ")"
            ).bindparams(**{key: t})
        )
    return clauses


def _exclude_static_images_sql():
    """SQL filter: hide static images (media_type=image). GIFs stay."""
    return MediaItem.media_type != "image"


def _media_list_order(sort: str, order: str):
    """sort: name | created | new | old. order: asc | desc (new/old keep legacy if order omitted)."""
    key = (sort or "new").strip().lower()
    if key in ("imported", "import", "time"):
        key = "created"
    dir_raw = (order or "").strip().lower()
    if dir_raw in ("asc", "desc"):
        descending = dir_raw == "desc"
    else:
        descending = key != "old"

    if key == "name":
        title_col = func.lower(func.coalesce(MediaItem.title, ""))
        if descending:
            return title_col.desc(), MediaItem.id.desc()
        return title_col.asc(), MediaItem.id.asc()
    if key == "created":
        if descending:
            return desc(MediaItem.created_at), desc(MediaItem.id)
        return asc(MediaItem.created_at), asc(MediaItem.id)
    if key == "old" or (key == "new" and not descending):
        return (asc(MediaItem.id),)
    return (desc(MediaItem.id),)


@router.get("/media", dependencies=[Depends(require_token)])
def list_media(
    type: str | None = None,
    q: str | None = None,
    tag: str | None = None,
    liked: bool | None = None,
    sort: str = "new",
    order: str = "",
    # True: include 限制级; False: hide them. Default True for manage UIs.
    include_restricted: bool = True,
    # True: include static images; False: hide media_type=image. Default True for manage UIs.
    include_images: bool = True,
    exclude_tags: str | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=48, ge=1, le=100),
    db=Depends(get_db),
):
    """
    Paginated media list with server-side filters (no full-table materialization).
    tag: matches tags_json containing the canonical tag string (JSON array storage).
    include_restricted: when False, hide items tagged 限制级.
    include_images: when False, hide static images (media_type=image).
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
    if not include_images:
        filters.append(_exclude_static_images_sql())
    for c in _exclude_tags_clauses(_parse_tag_list(exclude_tags)):
        filters.append(c)

    count_stmt = select(func.count()).select_from(MediaItem)
    list_stmt = select(MediaItem)
    for f in filters:
        count_stmt = count_stmt.where(f)
        list_stmt = list_stmt.where(f)

    list_stmt = list_stmt.order_by(*_media_list_order(sort, order))

    total = int(db.scalar(count_stmt) or 0)
    page = list(db.scalars(list_stmt.offset(offset).limit(limit)).all())
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": _media_outs(db, page),
    }


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


def _eligible_media_ids(db, stmt) -> list[int]:
    id_stmt = stmt.with_only_columns(MediaItem.id)
    return [int(i) for i in db.scalars(id_stmt).all()]


def _load_media_in_order(db, ids: list[int]) -> list:
    if not ids:
        return []
    rows = list(db.scalars(select(MediaItem).where(MediaItem.id.in_(ids))).all())
    by_id = {int(m.id): m for m in rows}
    return [by_id[i] for i in ids if i in by_id]


def _random_feed_rows(db, stmt, exclude: set[int], limit: int, settings):
    """Without-replacement sample from remaining ids. Empty remaining → new cycle."""
    pool_mult = max(1, int(getattr(settings, "feed_random_pool_mult", 3) or 3))
    sample_n = min(800, max(limit * pool_mult, limit + 10))
    all_ids = _eligible_media_ids(db, stmt)
    remain = [i for i in all_ids if i not in exclude]
    cycle_reset = False
    if not remain and all_ids:
        cycle_reset = True
        remain = list(all_ids)
    random.shuffle(remain)
    pick = remain[:sample_n]
    rows = _load_media_in_order(db, pick)
    rows = diversify_sequence(rows, limit=min(limit, len(rows)))
    return rows[:limit], cycle_reset


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
    # Default False: do not push static images unless client opts in
    include_images: bool = False,
    exclude_tags: str | None = None,
    db=Depends(get_db),
):
    """
    mode:
      - recommend: multi-channel (interest/fresh/explore/revisit) + fatigue + diversity
      - similar: same recommend ranking, constrained to focus tag= or seed-related items
      - recent: created_at then id desc (true ingest order)
      - random: full-library SQL RANDOM sample + light anti-clump
      - liked

    exclude_ids: comma-separated media ids already in the client playlist
    (for on-demand next batches without repeating).
    include_seed: when similar by media, put seed first (false for tail prefetch).
    tag: when mode=similar, only items carrying this tag (recommend-ranked within).
    include_restricted: when False (default), hide items tagged 限制级.
    include_images: when False (default), hide static images (media_type=image).
    exclude_tags: comma-separated tags; items carrying any of them are hidden.
    """
    exclude = _parse_id_set(exclude_ids)
    # over-fetch then filter so exclude does not shrink the page too much
    fetch_n = min(500, max(limit * 4, limit + len(exclude) + 20))
    focus_tag = canonical_tag(tag) if tag else ""
    settings = get_settings()

    stmt = select(MediaItem)
    if not include_restricted:
        stmt = stmt.where(_exclude_restricted_sql())
    if not include_images:
        stmt = stmt.where(_exclude_static_images_sql())
    for c in _exclude_tags_clauses(_parse_tag_list(exclude_tags)):
        stmt = stmt.where(c)
    if mode == "series":
        series_rows = list(
            db.scalars(
                select(MediaSeries).order_by(
                    desc(MediaSeries.updated_at), desc(MediaSeries.id)
                )
            ).all()
        )
        remain = [s for s in series_rows if int(s.id) not in exclude]
        cycle_reset = False
        if not remain and series_rows:
            cycle_reset = True
            remain = list(series_rows)
        hide_tags = set(_parse_tag_list(exclude_tags))
        picked: list = []
        for s in remain:
            m = _series_representative(db, s)
            if m is None:
                continue
            tags = set(tags_from_json(getattr(m, "tags_json", None)))
            if not include_restricted and RESTRICTED_TAG in tags:
                continue
            if hide_tags and (tags & hide_tags):
                continue
            picked.append(m)
            if len(picked) >= limit:
                break
        return {
            "mode": "series",
            "similar_to": similar_to,
            "tag": focus_tag or None,
            "random_cycle_reset": cycle_reset,
            "items": _media_outs(db, picked),
        }
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
        # Without replacement from remaining library; empty remaining starts a new cycle.
        rows, cycle_reset = _random_feed_rows(db, stmt, exclude, limit, settings)
        return {
            "mode": mode,
            "similar_to": similar_to,
            "tag": focus_tag or None,
            "random_cycle_reset": cycle_reset,
            "items": _media_outs(db, rows),
        }
    elif mode == "similar" or similar_to:
        # Same mixed pool as recommend (recent + random), not "latest N only"
        # — old path ordered by id and felt like sequential playback.
        n_recent = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_recent", 250) or 250),
        )
        n_rand = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_random", 250) or 250),
        )
        params = FeedRankParams.from_settings(settings)

        def _mixed_pool(base_stmt, *, recent_n: int, rand_n: int) -> list:
            recent_rows = list(
                db.scalars(
                    base_stmt.order_by(desc(MediaItem.id)).limit(recent_n)
                ).all()
            )
            rand_rows = list(
                db.scalars(base_stmt.order_by(func.random()).limit(rand_n)).all()
            )
            by_id: dict[int, MediaItem] = {}
            for m in recent_rows + rand_rows:
                by_id[int(m.id)] = m
            return list(by_id.values())

        if focus_tag:
            # Prefer SQL prefilter so random sample is within the tag, not
            # diluted by unrelated latest items.
            tag_token = focus_tag.replace('"', "").replace("\\", "")
            tag_stmt = stmt
            if tag_token:
                # tags_json is a JSON string array, e.g. ["foo","bar"]
                tag_stmt = stmt.where(MediaItem.tags_json.contains(f'"{tag_token}"'))
            pool = _mixed_pool(
                tag_stmt,
                recent_n=min(400, n_recent + 80),
                rand_n=min(400, n_rand + 80),
            )
            if len(pool) < max(12, limit):
                # Fallback: broader mixed pool then filter in rank_by_tag
                pool = _mixed_pool(stmt, recent_n=n_recent + 100, rand_n=n_rand + 100)
            rows = rank_by_tag(
                pool,
                focus_tag,
                limit=min(200, fetch_n),
                params=params,
            )
        else:
            pool = _mixed_pool(stmt, recent_n=n_recent + 50, rand_n=n_rand + 50)
            seed = db.get(MediaItem, similar_to) if similar_to else None
            if seed is None and pool:
                seed = pool[0]
            if seed is None:
                rows = []
            else:
                ranked = rank_similar(
                    pool, seed, limit=min(200, fetch_n), params=params
                )
                if not include_seed:
                    ranked = [m for m in ranked if m.id != seed.id]
                rows = ranked
        mode = "similar"
    else:
        # Mixed candidate pool: recent + random long-tail + never-played slice
        # so newly ingested unplayed items are not missing from the rank set.
        n_recent = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_recent", 250) or 250),
        )
        n_rand = max(
            50,
            int(getattr(settings, "feed_recommend_candidate_random", 250) or 250),
        )
        n_unplayed = max(
            0,
            int(getattr(settings, "feed_recommend_candidate_unplayed", 80) or 0),
        )
        recent_rows = list(
            db.scalars(stmt.order_by(desc(MediaItem.id)).limit(n_recent)).all()
        )
        rand_rows = list(
            db.scalars(stmt.order_by(func.random()).limit(n_rand)).all()
        )
        unplayed_rows: list = []
        if n_unplayed > 0:
            unplayed_stmt = stmt.where(MediaItem.view_count == 0).where(
                MediaItem.last_viewed_at.is_(None)
            )
            unplayed_rows = list(
                db.scalars(
                    unplayed_stmt.order_by(desc(MediaItem.id)).limit(n_unplayed)
                ).all()
            )
        by_id: dict[int, MediaItem] = {}
        for m in recent_rows + rand_rows + unplayed_rows:
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
        "random_cycle_reset": False,
        "items": _media_outs(db, rows),
    }


@router.post("/feed", dependencies=[Depends(require_token)])
def feed_post(body: FeedRequest, db=Depends(get_db)):
    """Same as GET /feed; exclude_ids as JSON list (random mode persistence)."""
    raw_ex = ",".join(str(int(x)) for x in (body.exclude_ids or []) if x is not None)
    return feed(
        mode=body.mode or "recommend",
        limit=body.limit,
        similar_to=body.similar_to,
        tag=body.tag,
        exclude_ids=raw_ex or None,
        include_seed=body.include_seed,
        include_restricted=body.include_restricted,
        include_images=body.include_images,
        exclude_tags=",".join(_parse_tag_list(body.exclude_tags)) or None,
        db=db,
    )


@router.post("/series", dependencies=[Depends(require_token)])
def create_series(body: SeriesCreate, db=Depends(get_db)):
    ids: list[int] = []
    seen: set[int] = set()
    for raw in body.ids or []:
        try:
            mid = int(raw)
        except (TypeError, ValueError):
            continue
        if mid <= 0 or mid in seen:
            continue
        seen.add(mid)
        ids.append(mid)
    if len(ids) < 2:
        raise HTTPException(400, "至少选择 2 条媒体")
    rows = _load_media_in_order(db, ids)
    if len(rows) != len(ids):
        missing = [i for i in ids if i not in {int(m.id) for m in rows}]
        raise HTTPException(404, f"媒体不存在: {missing[:8]}")
    taken = list(
        db.scalars(select(SeriesEpisode).where(SeriesEpisode.media_id.in_(ids))).all()
    )
    if taken:
        raise HTTPException(400, "部分媒体已属于其他剧集")
    title = (body.title or "").strip()
    if not title:
        title = (rows[0].title or "").strip() or f"剧集 #{rows[0].id}"
    s = MediaSeries(title=title[:512], current_media_id=int(rows[0].id), current_episode_index=1)
    db.add(s)
    db.flush()
    for i, m in enumerate(rows, start=1):
        db.add(SeriesEpisode(series_id=int(s.id), media_id=int(m.id), episode_index=i))
    db.commit()
    db.refresh(s)
    episodes = _series_episodes_out(db, s)
    return {
        "id": int(s.id),
        "title": s.title,
        "current_media_id": s.current_media_id,
        "current_episode_index": int(s.current_episode_index or 1),
        "episode_count": len(episodes),
        "episodes": episodes,
    }


@router.get("/series", dependencies=[Depends(require_token)])
def list_series(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=48, ge=1, le=100),
    include_restricted: bool = False,
    exclude_tags: str | None = None,
    db=Depends(get_db),
):
    """One card per series for the picker grid (cover = resume / first episode)."""
    hide_tags = set(_parse_tag_list(exclude_tags))
    series_rows = list(
        db.scalars(
            select(MediaSeries).order_by(
                desc(MediaSeries.updated_at), desc(MediaSeries.id)
            )
        ).all()
    )
    picked: list[MediaSeries] = []
    for s in series_rows:
        m = _series_representative(db, s)
        if m is None:
            continue
        tags = set(tags_from_json(getattr(m, "tags_json", None)))
        if not include_restricted and RESTRICTED_TAG in tags:
            continue
        if hide_tags and (tags & hide_tags):
            continue
        picked.append(s)
    total = len(picked)
    page = picked[offset : offset + limit]
    items = []
    for s in page:
        m = _series_representative(db, s)
        n = int(
            db.scalar(
                select(func.count())
                .select_from(SeriesEpisode)
                .where(SeriesEpisode.series_id == int(s.id))
            )
            or 0
        )
        cover = _media_out_one(db, m) if m is not None else None
        items.append(
            {
                "id": int(s.id),
                "title": s.title or "",
                "episode_count": n,
                "current_media_id": s.current_media_id,
                "current_episode_index": int(s.current_episode_index or 1),
                "cover": cover,
            }
        )
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@router.get("/series/{series_id}", dependencies=[Depends(require_token)])
def get_series(series_id: int, db=Depends(get_db)):
    s = db.get(MediaSeries, series_id)
    if not s:
        raise HTTPException(404, "剧集不存在")
    episodes = _series_episodes_out(db, s)
    return {
        "id": int(s.id),
        "title": s.title,
        "current_media_id": s.current_media_id,
        "current_episode_index": int(s.current_episode_index or 1),
        "episode_count": len(episodes),
        "episodes": episodes,
    }


@router.delete("/series/{series_id}", dependencies=[Depends(require_token)])
def delete_series(series_id: int, db=Depends(get_db)):
    s = db.get(MediaSeries, series_id)
    if not s:
        raise HTTPException(404, "剧集不存在")
    eps = list(db.scalars(select(SeriesEpisode).where(SeriesEpisode.series_id == series_id)).all())
    for e in eps:
        db.delete(e)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/media/{media_id}", dependencies=[Depends(require_token)])
def get_media(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    return _media_out_one(db, m)


@router.get("/media/{media_id}/subtitle", dependencies=[Depends(require_token)])
def media_subtitle(media_id: int, format: str = "vtt"):
    """Sidecar subtitle. format=vtt (player) or srt (download)."""
    try:
        srt = read_srt(int(media_id))
    except SubtitleStoreError as e:
        raise HTTPException(e.status_code, str(e)) from e
    fmt = (format or "vtt").lower()
    if fmt == "srt":
        return PlainTextResponse(srt, media_type="application/x-subrip; charset=utf-8")
    return PlainTextResponse(srt_to_vtt(srt), media_type="text/vtt; charset=utf-8")


@router.put("/media/{media_id}/subtitle", dependencies=[Depends(require_token)])
async def media_subtitle_put(media_id: int, request: Request, db=Depends(get_db)):
    """Store an SRT for this id. The video file is unchanged."""
    m = db.get(MediaItem, int(media_id))
    if not m:
        raise HTTPException(404, "Not found")
    raw = await request.body()
    if len(raw) > 2_000_000:
        raise HTTPException(400, "subtitle too large")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise HTTPException(400, "字幕须为 UTF-8") from e
    try:
        save_srt(int(media_id), text)
    except SubtitleStoreError as e:
        raise HTTPException(e.status_code, str(e)) from e
    return {"ok": True, "media_id": int(media_id), "has_subtitle": True}


@router.get("/media/{media_id}/file", dependencies=[Depends(require_token)])
def media_file(media_id: int):
    """
    Stream media with Range support (native <video> on mobile).
    Auth: header or ?token= (see require_token).

    DB session is closed before FileResponse so concurrent video streams do not
    pin SQLite connections for the entire transfer (was exhausting QueuePool).
    """
    from app.core.db import SessionLocal, init_db

    if SessionLocal is None:
        init_db()
    assert SessionLocal is not None
    with SessionLocal() as db:
        m = db.get(MediaItem, media_id)
        if not m:
            raise HTTPException(404, "Not found")
        rel_path = m.rel_path
        mime = m.mime
        mtype = (m.media_type or "").lower()
        mid = m.id
        file_size = m.file_size or 0
    path = get_settings().medias_path() / rel_path
    if not path.is_file():
        raise HTTPException(404, "File missing on disk")
    media = mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    # webm leftovers: still serve, but prefer correct type for mp4 after remux
    suf = path.suffix.lower()
    if mtype == "audio":
        if not media or media == "application/octet-stream":
            media = mimetypes.guess_type(path.name)[0] or "audio/mpeg"
        if media.startswith("video/") and suf in (".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus"):
            media = mimetypes.guess_type(path.name)[0] or "audio/mpeg"
    elif suf == ".mp4":
        media = "video/mp4"
    elif suf == ".webm":
        media = "video/webm"
    try:
        st = path.stat()
        etag = f'"{st.st_mtime_ns}-{st.st_size}"'
    except OSError:
        etag = f'"{mid}-{file_size}"'
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
def media_thumb(media_id: int):
    """Serve thumb; close DB before FileResponse (same pool reason as /file)."""
    from app.core.db import SessionLocal, init_db

    if SessionLocal is None:
        init_db()
    assert SessionLocal is not None
    tpath = thumb_path_for(media_id)
    with SessionLocal() as db:
        m = db.get(MediaItem, media_id)
        if not m:
            raise HTTPException(404, "Not found")
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
    _detach_media_from_series(db, int(m.id))
    path = get_settings().medias_path() / m.rel_path
    if path.is_file():
        path.unlink(missing_ok=True)
    tpath = thumb_path_for(m.id)
    tpath.unlink(missing_ok=True)
    delete_subtitle(int(m.id))
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


@router.post("/media/dedupe", dependencies=[Depends(require_token)])
def media_dedupe(body: MediaDedupeRequest = MediaDedupeRequest(), db=Depends(get_db)):
    """
    One-click dedupe: drop MediaItem rows whose files are byte-identical
    (same size + SHA-256). Keeps the preferred item per group (liked /
    engagement / review, then oldest id). Does not merge tags.
    """
    result = dedupe_identical_media(
        db,
        dry_run=bool(body.dry_run),
        delete_row=_delete_media_row,
    )
    return result.as_dict()


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
    if body.review is not None:
        text = body.review if isinstance(body.review, str) else str(body.review)
        if len(text) > 2000:
            raise HTTPException(400, "review too long (max 2000)")
        m.review = "" if not text.strip() else text
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


def _apply_duration_sec(m: MediaItem, duration_sec: float | None) -> None:
    """Store duration when missing or when a clearly better value arrives."""
    if duration_sec is None:
        return
    try:
        d = float(duration_sec)
    except (TypeError, ValueError):
        return
    if not math.isfinite(d) or d <= 0 or d > 86400 * 12:
        return
    prev = getattr(m, "duration_sec", None)
    if prev is None or float(prev or 0) <= 0:
        m.duration_sec = d
    elif abs(float(prev) - d) / max(float(prev), 1.0) > 0.15 and d > float(prev):
        # Prefer longer credible duration (e.g. full file vs partial probe)
        m.duration_sec = d


def _apply_progress(m: MediaItem, progress: float | None) -> None:
    if progress is None:
        return
    try:
        p = float(progress)
    except (TypeError, ValueError):
        return
    if not math.isfinite(p):
        return
    p = max(0.0, min(1.0, p))
    cur = float(getattr(m, "max_progress", 0) or 0)
    if p > cur:
        m.max_progress = p


def _apply_last_position(m: MediaItem, position_sec: float | None) -> None:
    if position_sec is None:
        return
    try:
        t = float(position_sec)
    except (TypeError, ValueError):
        return
    if not math.isfinite(t):
        return
    m.last_position_sec = max(0.0, min(t, 86400 * 12))


@router.post("/media/{media_id}/interact", dependencies=[Depends(require_token)])
def interact(media_id: int, body: InteractEvent, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    ev = (body.event or "view").lower()
    now = datetime.now(timezone.utc)
    _apply_duration_sec(m, body.duration_sec)
    _apply_last_position(m, body.position_sec)
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
    elif ev == "progress":
        _apply_progress(m, body.progress)
        m.last_viewed_at = now
        if int(m.view_count or 0) == 0:
            m.view_count = 1
    elif ev == "ended":
        _apply_progress(m, body.progress if body.progress is not None else 1.0)
        m.last_viewed_at = now
        if int(m.view_count or 0) == 0:
            m.view_count = 1
        if body.position_sec is None:
            m.last_position_sec = 0.0
    else:
        raise HTTPException(400, "event must be view|dwell|skip|progress|ended")
    if ev in ("view", "progress", "ended", "dwell"):
        _touch_series_cursor(db, m)
    db.commit()
    db.refresh(m)
    return _media_out_one(db, m)


def _short(s: str | None, n: int = 120) -> str:
    t = (s or "").replace("\n", " ").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


@router.post("/ingest", dependencies=[Depends(require_token)])
async def ingest(body: IngestRequest):
    items = []
    default_tags = apply_restricted_flag(body.tags, body.restricted)
    for it in body.items:
        d = it.model_dump()
        if body.use_jasna and not d.get("use_jasna"):
            d["use_jasna"] = True
        if body.allow_ios_incompatible and not d.get("allow_ios_incompatible"):
            d["allow_ios_incompatible"] = True
        item_restricted = bool(d.pop("restricted", False) or body.restricted)
        raw = d.get("tags") or body.tags or []
        d["tags"] = apply_restricted_flag(raw, item_restricted)
        items.append(d)
    t0 = time.perf_counter()
    logger.info(
        "ingest start items=%s tags=%s jasna=%s",
        len(items),
        len(default_tags or []),
        bool(body.use_jasna),
    )
    result = await enqueue_jobs(
        "default",
        items,
        default_tags=default_tags,
    )
    ms = (time.perf_counter() - t0) * 1000
    logger.info(
        "ingest done accepted=%s dup=%s rejected_live=%s jobs=%s %.0fms",
        result.get("accepted"),
        result.get("duplicates"),
        result.get("rejected_live"),
        result.get("job_ids"),
        ms,
    )
    if result.get("rejected_live_samples"):
        for sample in result.get("rejected_live_samples") or []:
            logger.info("ingest rejected_live sample: %s", sample)
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
    # Client hint only — real type decided after write via ffprobe/magic
    mtype_hint = media_type or detect_media_type(raw_name, file.content_type, None)
    if mtype_hint == "m3u8":
        mtype_hint = "video"
    if mtype_hint not in ("image", "gif", "video", "audio"):
        ct0 = (file.content_type or "").lower()
        mtype_hint = "audio" if ct0.startswith("audio/") else "video"
    # Disambiguate dest name: same display title + same client filename (e.g. two
    # JasnaBridge jobs both sending "out.mp4") must not share one rel_path, or
    # the second upload overwrites the first and both report the same media_id.
    t0 = time.perf_counter()
    logger.info(
        "upload start name=%s title=%s hint=%s src=%s",
        _short(raw_name, 80),
        _short(title, 80),
        mtype_hint,
        _short(source_url, 140),
    )

    fname = safe_filename(
        title or Path(raw_name).stem,
        source_url or raw_name,
        ext,
        disambiguator=f"up|{raw_name}|{time.time_ns()}",
    )
    dest = settings.medias_path() / fname
    dest = ensure_unique_path(dest)
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
    except HTTPException as e:
        dest.unlink(missing_ok=True)
        logger.warning(
            "upload reject name=%s bytes=%s detail=%s",
            _short(raw_name, 80),
            written,
            getattr(e, "detail", e),
        )
        raise
    except Exception:
        dest.unlink(missing_ok=True)
        logger.exception(
            "upload write failed name=%s bytes=%s", _short(raw_name, 80), written
        )
        raise
    if written < 1:
        dest.unlink(missing_ok=True)
        logger.warning("upload empty name=%s", _short(raw_name, 80))
        raise HTTPException(400, "Empty file")
    mime = file.content_type or ""
    note = ""
    # Content classification BEFORE remux (audio-in-.mp4 must not be remuxed as video)
    cls = classify_media_file(dest, hinted=mtype_hint, content_type=mime)
    mtype = cls.get("media_type") or mtype_hint
    if cls.get("mime"):
        mime = cls["mime"]
    if cls.get("method"):
        note = f"class:{cls['method']}"
        if cls.get("role"):
            note += f":{cls['role']}"
    if remux not in ("0", "false", "False") and mtype == "video" and cls.get("has_video"):
        try:
            dest2 = remux_to_playable(dest, prefer_ext=ext)
            if dest2 != dest:
                dest = dest2
                note = (note + ";remuxed") if note else "remuxed"
            mime = mimetypes.guess_type(dest.name)[0] or mime or "video/mp4"
            # re-check after remux (should still be video)
            cls2 = classify_media_file(dest, hinted=mtype, content_type=mime)
            if cls2.get("media_type") in ("audio", "video", "image", "gif"):
                mtype = cls2["media_type"]
            if cls2.get("mime"):
                mime = cls2["mime"]
        except Exception as e:
            note = (note + f";remux_skip:{e}") if note else f"remux_skip:{e}"
    if mtype == "audio" and (not mime or mime.startswith("video/")):
        mime = cls.get("mime") or "audio/mp4"
    tag_list = apply_restricted_flag(tags, _flag_true(restricted))
    reg = register_uploaded_file(
        category="default",
        dest=dest,
        title=title or Path(raw_name).stem,
        source_url=source_url,
        media_type=mtype,
        mime=mime,
        dedupe=False,
        tags=tag_list,
    )
    item = reg.item
    if reg.duplicate:
        note = (note + ";content_duplicate") if note else "content_duplicate"
    jasna_job_id = None
    jasna_skipped = False
    jasna_skip_reason = ""
    if not reg.duplicate and _flag_true(use_jasna) and mtype == "video":
        if not bool(getattr(settings, "jasna_enabled", False)):
            jasna_skipped = True
            jasna_skip_reason = (
                "server jasna disabled; demosaic via local JasnaBridge then re-upload"
            )
        else:
            jasna_job_id = enqueue_jasna_for_media(item.id)
            if jasna_job_id is None:
                jasna_skipped = True
                jasna_skip_reason = "jasna unavailable or enqueue skipped"
    ms = (time.perf_counter() - t0) * 1000
    logger.info(
        "upload ok media_id=%s type=%s role=%s bytes=%s dup=%s note=%s %.0fms",
        item.id,
        mtype,
        cls.get("role"),
        written,
        bool(reg.duplicate),
        _short(note, 160),
        ms,
    )
    return {
        "media_id": item.id,
        "item": _media_out(item),
        "duplicate": bool(reg.duplicate),
        "note": note,
        "classify": {
            "media_type": mtype,
            "role": cls.get("role"),
            "method": cls.get("method"),
            "duration_sec": cls.get("duration_sec"),
        },
        "jasna_job_id": jasna_job_id,
        "jasna_skipped": jasna_skipped,
        "jasna_skip_reason": jasna_skip_reason,
    }


@router.post("/media/reclassify", dependencies=[Depends(require_token)])
def media_reclassify(body: MediaReclassifyRequest, db=Depends(get_db)):
    """
    Re-probe on-disk media with ffprobe/magic and correct media_type.
    Extension/suffix is ignored — pure-audio .mp4 becomes audio.
    """
    settings = get_settings()
    medias = settings.medias_path()
    if body.ids:
        q = select(MediaItem).where(MediaItem.id.in_([int(x) for x in body.ids if int(x) > 0]))
    elif body.include_images:
        q = select(MediaItem)
    else:
        q = select(MediaItem).where(MediaItem.media_type.in_(("video", "audio", "m3u8")))
    rows = list(db.scalars(q).all())
    changed: list[dict] = []
    unchanged = 0
    failed: list[dict] = []
    for m in rows:
        path = medias / m.rel_path
        if not path.is_file():
            failed.append({"id": m.id, "error": "missing_file"})
            continue
        try:
            cls = classify_media_file(path, hinted=m.media_type, content_type=m.mime)
            new_type = cls.get("media_type") or m.media_type
            if new_type == "m3u8":
                new_type = "video"
            old = (m.media_type or "").lower()
            if new_type != old or (cls.get("mime") and cls["mime"] != (m.mime or "")):
                m.media_type = new_type
                if cls.get("mime"):
                    m.mime = cls["mime"]
                changed.append(
                    {
                        "id": m.id,
                        "from": old,
                        "to": new_type,
                        "role": cls.get("role"),
                        "method": cls.get("method"),
                        "duration_sec": cls.get("duration_sec"),
                    }
                )
            else:
                unchanged += 1
        except Exception as e:
            failed.append({"id": m.id, "error": str(e)[:200]})
    if changed:
        db.commit()
    return {
        "scanned": len(rows),
        "changed": len(changed),
        "unchanged": unchanged,
        "failed": len(failed),
        "items": changed[:200],
        "errors": failed[:50],
    }


@router.post("/media/probe-url", dependencies=[Depends(require_token)])
async def media_probe_url(body: ProbeUrlRequest):
    """
    Lightweight remote classify: download only a small head (and optional tail),
    run ffprobe/magic, delete temp. Does NOT pull the full media file.

    Used by extension when list items may use a video extension for pure audio.
    Full-file download remains for merge/ingest, not for type detection.
    """
    import tempfile

    import httpx

    url = (body.url or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(400, "valid http(s) url required")
    # Default: ~4MiB head — enough for most containers / stream headers; not full film
    PROBE_DEFAULT_HEAD = 4 * 1024 * 1024
    PROBE_DEFAULT_TAIL = 1 * 1024 * 1024
    PROBE_HARD_CAP = 32 * 1024 * 1024  # never more than 32MiB for a probe call
    max_b = int(body.max_bytes or 0) or PROBE_DEFAULT_HEAD
    max_b = max(64 * 1024, min(max_b, PROBE_HARD_CAP))
    tb = int(body.tail_bytes or 0)
    if tb == 0:
        tail_b = PROBE_DEFAULT_TAIL
    elif tb < 0:
        tail_b = 0
    else:
        tail_b = min(tb, PROBE_HARD_CAP)
    headers = {str(k): str(v) for k, v in (body.headers or {}).items() if v is not None}
    # Avoid clobbering an explicit Range from the caller
    has_range = any(k.lower() == "range" for k in headers)
    suffix = Path(url.split("?")[0]).suffix or ".bin"
    if len(suffix) > 12:
        suffix = ".bin"
    tmp_path: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix="lmw_probe_", suffix=suffix)
        import os

        try:
            os.close(fd)
        except OSError:
            pass
        tmp_path = Path(name)
        written = 0
        truncated = False
        ct = ""
        content_len: int | None = None
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(45.0, connect=15.0),
            trust_env=True,
        ) as client:
            req_headers = dict(headers)
            if not has_range:
                # Ask CDN for only the head when possible (206 or full 200)
                req_headers["Range"] = f"bytes=0-{max_b - 1}"
            async with client.stream("GET", url, headers=req_headers) as resp:
                if resp.status_code >= 400:
                    raise HTTPException(400, f"download HTTP {resp.status_code}")
                ct = (resp.headers.get("content-type") or "").split(";")[0].strip()
                # Content-Range: bytes 0-N/total  or Content-Length on 200
                cr = resp.headers.get("content-range") or ""
                if "/" in cr:
                    try:
                        total_s = cr.rsplit("/", 1)[-1].strip()
                        if total_s.isdigit():
                            content_len = int(total_s)
                    except ValueError:
                        pass
                if content_len is None:
                    try:
                        cl = int(resp.headers.get("content-length") or 0)
                        if cl > 0:
                            content_len = cl
                    except ValueError:
                        pass
                with tmp_path.open("wb") as out:
                    async for chunk in resp.aiter_bytes(64 * 1024):
                        if not chunk:
                            continue
                        remain = max_b - written
                        if remain <= 0:
                            truncated = True
                            break
                        if len(chunk) > remain:
                            out.write(chunk[:remain])
                            written += remain
                            truncated = True
                            break
                        out.write(chunk)
                        written += len(chunk)
                # If server ignored Range and kept streaming, we already stopped early
                if content_len is not None and content_len > written:
                    truncated = True

            # Optional tail for moov-at-end: append after a gap is invalid for mp4;
            # instead re-fetch only the last tail_b into a *separate* classify pass
            # by rewriting file as head||tail only when both fit and file is larger.
            # For simplicity: if head alone has no duration and we know size, replace
            # with head + last tail (ffmpeg often still reads streams from head).
            if (
                tail_b > 0
                and content_len is not None
                and content_len > written + 1024
                and content_len - written > tail_b // 2
            ):
                start = max(0, content_len - tail_b)
                # Skip if tail overlaps head we already have
                if start >= written:
                    try:
                        th = dict(headers)
                        th["Range"] = f"bytes={start}-{content_len - 1}"
                        tr = await client.get(url, headers=th)
                        if tr.status_code in (200, 206) and tr.content:
                            # Write sparse-ish: head + tail concatenated with note.
                            # Stream topology is usually in moov (tail) or early boxes (head);
                            # concatenating is imperfect but often enough for role detect.
                            with tmp_path.open("ab") as out:
                                out.write(tr.content[:tail_b])
                            written += min(len(tr.content), tail_b)
                            truncated = True
                    except Exception:
                        pass

        if written < 16:
            raise HTTPException(400, "empty download")
        cls = classify_media_file(tmp_path, content_type=ct)
        method = cls.get("method") or ""
        if truncated and method:
            method = f"{method}_partial"
        return {
            "url": url,
            "bytes": written,
            "truncated": truncated,
            "content_length": content_len,
            "media_type": cls.get("media_type"),
            "role": cls.get("role"),
            "has_video": cls.get("has_video"),
            "has_audio": cls.get("has_audio"),
            "duration_sec": cls.get("duration_sec"),
            "vcodec": cls.get("vcodec") or "",
            "acodec": cls.get("acodec") or "",
            "ios_ok": cls.get("ios_ok"),
            "ios_reason": cls.get("ios_reason") or "",
            "mime": cls.get("mime"),
            "method": method,
            "summary": cls.get("summary"),
            "error": cls.get("error") or "",
        }
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


@router.post("/media/av-match", dependencies=[Depends(require_token)])
def media_av_match(body: AvMatchRequest, db=Depends(get_db)):
    """
    Scan library for complete single-file video_only + audio_only items whose
    durations highly match. Used by extension manage page to pair silent video + audio.
    Classification uses ffprobe role (not extension / DB label alone).
    """
    if not ffmpeg_available():
        raise HTTPException(400, "ffmpeg/ffprobe 不可用，无法检测时长")
    settings = get_settings()
    medias = settings.medias_path()
    q = select(MediaItem).where(MediaItem.media_type.in_(("video", "audio")))
    if body.ids:
        q = q.where(MediaItem.id.in_([int(x) for x in body.ids if int(x) > 0]))
    rows = list(db.scalars(q).all())
    videos: list[dict] = []
    audios: list[dict] = []
    skipped: list[dict] = []
    type_fixes = 0
    for m in rows:
        if getattr(m, "partial", False):
            skipped.append({"id": m.id, "reason": "partial"})
            continue
        path = medias / m.rel_path
        if not path.is_file() or path.stat().st_size < 64:
            skipped.append({"id": m.id, "reason": "missing_file"})
            continue
        # m3u8 leftovers stored as video still may be playlists — skip tiny/non-media
        suf = path.suffix.lower()
        if suf in (".m3u8", ".mpd"):
            skipped.append({"id": m.id, "reason": "stream_playlist"})
            continue
        cls = classify_media_file(path, hinted=m.media_type, content_type=m.mime)
        role = cls.get("role") or "unknown"
        real_type = cls.get("media_type") or (m.media_type or "video")
        # Auto-fix DB label when content disagrees (audio disguised as video)
        if real_type in ("audio", "video") and real_type != (m.media_type or "").lower():
            m.media_type = real_type
            if cls.get("mime"):
                m.mime = cls["mime"]
            type_fixes += 1
        dur = cls.get("duration_sec")
        if dur is None or float(dur) <= 0.05:
            # fall back to role probe duration
            probe = probe_single_file_role(path)
            role = probe.get("role") or role
            dur = probe.get("duration_sec")
        if dur is None or float(dur) <= 0.05:
            skipped.append(
                {
                    "id": m.id,
                    "reason": "no_duration",
                    "role": role,
                    "error": cls.get("error") or "",
                }
            )
            continue
        entry = {
            "id": m.id,
            "title": m.title or "",
            "duration_sec": float(dur),
            "role": role,
            "media_type": real_type,
            "file_size": int(m.file_size or 0),
        }
        # Bucket by content role, not by stored label
        if role == "audio_only" or (real_type == "audio" and role != "av" and role != "video_only"):
            if role == "av":
                skipped.append({"id": m.id, "reason": "av_not_audio_only"})
                continue
            if role == "video_only":
                skipped.append({"id": m.id, "reason": "video_only_as_audio"})
                continue
            audios.append(entry)
        elif role == "video_only":
            videos.append(entry)
        elif role == "av" and body.include_av_videos:
            videos.append(entry)
        else:
            skipped.append(
                {
                    "id": m.id,
                    "reason": f"not_merge_candidate:{role}",
                    "summary": cls.get("summary") or "",
                }
            )
    if type_fixes:
        try:
            db.commit()
        except Exception:
            db.rollback()

    pairs = match_av_by_duration(
        videos,
        audios,
        abs_tol=float(body.abs_tol_sec or 0.45),
        rel_tol=float(body.rel_tol or 0.02),
        min_score=float(body.min_score or 0.97),
    )
    return {
        "pairs": pairs,
        "scanned": {
            "total": len(rows),
            "videos": len(videos),
            "audios": len(audios),
            "skipped": len(skipped),
            "type_fixes": type_fixes,
        },
        "videos": videos,
        "audios": audios,
        "skipped": skipped[:200],
        "ffmpeg": True,
    }


@router.post("/media/merge-av", dependencies=[Depends(require_token)])
def media_merge_av_library(body: AvMergeRequest, db=Depends(get_db)):
    """
    Fast-merge library video + audio files into a new video media item.
    Sources stay unless delete_sources=true.
    """
    if not body.pairs:
        raise HTTPException(400, "pairs required")
    if not ffmpeg_available():
        raise HTTPException(400, "ffmpeg 不可用，无法合并")
    settings = get_settings()
    medias = settings.medias_path()
    medias.mkdir(parents=True, exist_ok=True)
    tag_list = normalize_tags(body.tags or [])
    results: list[dict] = []
    errors: list[dict] = []
    t0 = time.perf_counter()
    logger.info(
        "merge-av library start pairs=%s delete_sources=%s",
        len(body.pairs),
        bool(body.delete_sources),
    )
    for pair in body.pairs:
        vid = int(pair.video_id)
        aid = int(pair.audio_id)
        if vid <= 0 or aid <= 0 or vid == aid:
            errors.append({"video_id": vid, "audio_id": aid, "error": "invalid ids"})
            logger.warning("merge-av skip invalid ids v=%s a=%s", vid, aid)
            continue
        mv = db.get(MediaItem, vid)
        ma = db.get(MediaItem, aid)
        if not mv or not ma:
            errors.append({"video_id": vid, "audio_id": aid, "error": "not found"})
            logger.warning("merge-av not found v=%s a=%s", vid, aid)
            continue
        vpath = medias / mv.rel_path
        apath = medias / ma.rel_path
        if not vpath.is_file() or not apath.is_file():
            errors.append({"video_id": vid, "audio_id": aid, "error": "file missing"})
            logger.warning("merge-av file missing v=%s a=%s", vid, aid)
            continue
        title_tpl = (body.title or "").strip()
        if title_tpl:
            title = (
                title_tpl.replace("{video}", mv.title or "")
                .replace("{audio}", ma.title or "")
                .strip()
            )
        else:
            title = (mv.title or "merged").strip()
            if ma.title and ma.title not in title:
                title = f"{title}+{ma.title}"
        title = (title or "merged")[:512]
        fname = safe_filename(title, f"merge|{vid}|{aid}", "mp4")
        dest = medias / fname
        try:
            if dest.exists():
                dest.unlink()
            merge_av_to_mp4(vpath, apath, dest)
            reg = register_uploaded_file(
                category="default",
                dest=dest,
                title=title,
                source_url=f"merge://{vid}+{aid}",
                media_type="video",
                mime="video/mp4",
                dedupe=False,
                tags=tag_list
                or normalize_tags(
                    tags_from_json(getattr(mv, "tags_json", None))
                    + tags_from_json(getattr(ma, "tags_json", None))
                ),
            )
            item = reg.item
            if body.delete_sources:
                for m in (mv, ma):
                    # Never delete the row we just re-used as the merge result
                    if reg.duplicate and int(m.id) == int(item.id):
                        continue
                    try:
                        _delete_media_row(db, m)
                    except Exception:
                        pass
                db.commit()
            results.append(
                {
                    "media_id": item.id,
                    "item": _media_out(item),
                    "video_id": vid,
                    "audio_id": aid,
                    "note": "content_duplicate" if reg.duplicate else "merged",
                    "duplicate": bool(reg.duplicate),
                }
            )
            logger.info(
                "merge-av ok media_id=%s v=%s a=%s dup=%s size=%s",
                item.id,
                vid,
                aid,
                bool(reg.duplicate),
                getattr(item, "file_size", None),
            )
        except Exception as e:
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            errors.append(
                {
                    "video_id": vid,
                    "audio_id": aid,
                    "error": str(e)[:400],
                }
            )
            logger.exception("merge-av failed v=%s a=%s: %s", vid, aid, e)
    ms = (time.perf_counter() - t0) * 1000
    logger.info(
        "merge-av library done merged=%s failed=%s %.0fms",
        len(results),
        len(errors),
        ms,
    )
    return {
        "merged": len(results),
        "failed": len(errors),
        "items": results,
        "errors": errors,
    }


@router.post("/media/concat", dependencies=[Depends(require_token)])
def media_concat_library(body: MediaConcatRequest, db=Depends(get_db)):
    """
    Concatenate complete library video files in the given id order (ffmpeg).
    Produces one new media item. Optionally delete source rows.
    """
    ids = [int(x) for x in (body.ids or []) if int(x) > 0]
    # preserve order, drop dup ids
    seen: set[int] = set()
    ordered: list[int] = []
    for i in ids:
        if i in seen:
            continue
        seen.add(i)
        ordered.append(i)
    if len(ordered) < 1:
        raise HTTPException(400, "ids required")
    if not ffmpeg_available():
        raise HTTPException(400, "ffmpeg 不可用，无法拼接")
    settings = get_settings()
    medias = settings.medias_path()
    paths: list[Path] = []
    sources: list[MediaItem] = []
    for mid in ordered:
        m = db.get(MediaItem, mid)
        if not m:
            raise HTTPException(404, f"media {mid} not found")
        if getattr(m, "partial", False):
            raise HTTPException(400, f"media {mid} is partial, cannot concat")
        p = medias / m.rel_path
        if not p.is_file() or p.stat().st_size < 32:
            raise HTTPException(400, f"media {mid} file missing")
        paths.append(p)
        sources.append(m)
    titles = [((m.title or "").strip() or f"id{m.id}") for m in sources]
    title = (body.title or "").strip()
    if not title:
        title = titles[0] + (f"+{len(titles) - 1}段" if len(titles) > 1 else "")
    title = title[:512]
    tag_list = apply_restricted_flag(
        normalize_tags(body.tags or []),
        bool(body.restricted),
    )
    if not tag_list:
        # merge tags from sources
        acc: list[str] = []
        for m in sources:
            acc.extend(tags_from_json(getattr(m, "tags_json", None)))
        tag_list = apply_restricted_flag(normalize_tags(acc), bool(body.restricted))
    import time as _time

    fname = safe_filename(
        title,
        "concat|" + "+".join(str(i) for i in ordered),
        "mp4",
        disambiguator=f"concat|{_time.time_ns()}",
    )
    dest = ensure_unique_path(medias / fname)
    try:
        concat_videos_to_mp4(paths, dest)
        reg = register_uploaded_file(
            category="default",
            dest=dest,
            title=title,
            source_url="concat://" + "+".join(str(i) for i in ordered),
            media_type="video",
            mime="video/mp4",
            dedupe=False,
            tags=tag_list,
        )
        item = reg.item
        if body.delete_sources:
            for m in sources:
                if reg.duplicate and int(m.id) == int(item.id):
                    continue
                try:
                    _delete_media_row(db, m)
                except Exception:
                    pass
            try:
                db.commit()
            except Exception:
                db.rollback()
        jasna_job_id = None
        jasna_skipped = False
        jasna_skip_reason = ""
        if not reg.duplicate and body.use_jasna:
            if not bool(getattr(settings, "jasna_enabled", False)):
                jasna_skipped = True
                jasna_skip_reason = (
                    "server jasna disabled; demosaic via local JasnaBridge then re-upload"
                )
            else:
                jasna_job_id = enqueue_jasna_for_media(item.id)
                if jasna_job_id is None:
                    jasna_skipped = True
                    jasna_skip_reason = "jasna unavailable or enqueue skipped"
        return {
            "media_id": item.id,
            "item": _media_out(item),
            "duplicate": bool(reg.duplicate),
            "segments": ordered,
            "note": "content_duplicate" if reg.duplicate else f"concat:{len(ordered)}",
            "jasna_job_id": jasna_job_id,
            "jasna_skipped": jasna_skipped,
            "jasna_skip_reason": jasna_skip_reason,
        }
    except HTTPException:
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        raise
    except Exception as e:
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        raise HTTPException(400, f"concat failed: {e}") from e


@router.post("/upload-concat", dependencies=[Depends(require_token)])
async def upload_concat(
    category: str = Form("default"),
    title: str = Form(""),
    source_url: str = Form(""),
    tags: str = Form(""),
    use_jasna: str = Form("0"),
    restricted: str = Form("0"),
    files: list[UploadFile] = File(...),
):
    """
    Upload multiple progressive video parts in order; ffmpeg-concat into one library video.
    Field name: ``files`` (repeat) — order of parts is request order.
    """
    ensure_category(category)
    if not ffmpeg_available():
        raise HTTPException(400, "ffmpeg 不可用，无法拼接")
    parts = [f for f in (files or []) if f is not None]
    if len(parts) < 1:
        raise HTTPException(400, "files required")
    settings = get_settings()
    max_bytes = int(settings.max_file_bytes or 0)
    tmp_paths: list[Path] = []
    total = 0
    chunk_size = 1024 * 1024
    try:
        for idx, f in enumerate(parts):
            raw_name = f.filename or f"part{idx}.mp4"
            ext = Path(raw_name).suffix or ".mp4"
            if not ext.startswith("."):
                ext = "." + ext
            fd, tmp_name = tempfile.mkstemp(suffix=ext, prefix=f"lmw_c{idx}_")
            try:
                import os as _os

                _os.close(fd)
            except OSError:
                pass
            fd_path = Path(tmp_name)
            written = 0
            try:
                with fd_path.open("wb") as out:
                    while True:
                        chunk = await f.read(chunk_size)
                        if not chunk:
                            break
                        written += len(chunk)
                        total += len(chunk)
                        if max_bytes and total > max_bytes:
                            raise HTTPException(400, "File too large")
                        out.write(chunk)
            except HTTPException:
                fd_path.unlink(missing_ok=True)
                raise
            if written < 32:
                fd_path.unlink(missing_ok=True)
                raise HTTPException(400, f"Empty part #{idx + 1}")
            tmp_paths.append(fd_path)

        title_s = (title or "").strip() or "concat"
        import time as _time

        fname = safe_filename(
            title_s,
            source_url or "upload-concat",
            "mp4",
            disambiguator=f"upcat|{_time.time_ns()}",
        )
        dest = ensure_unique_path(settings.medias_path() / fname)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            concat_videos_to_mp4(tmp_paths, dest)
        except Exception as e:
            if dest.exists():
                try:
                    dest.unlink()
                except OSError:
                    pass
            raise HTTPException(400, f"concat failed: {e}") from e

        reg = register_uploaded_file(
            category="default",
            dest=dest,
            title=title_s[:512],
            source_url=source_url or "upload-concat://",
            media_type="video",
            mime="video/mp4",
            dedupe=False,
            tags=apply_restricted_flag(tags, _flag_true(restricted)),
        )
        item = reg.item
        jasna_job_id = None
        jasna_skipped = False
        jasna_skip_reason = ""
        if not reg.duplicate and _flag_true(use_jasna):
            if not bool(getattr(settings, "jasna_enabled", False)):
                jasna_skipped = True
                jasna_skip_reason = (
                    "server jasna disabled; demosaic via local JasnaBridge then re-upload"
                )
            else:
                jasna_job_id = enqueue_jasna_for_media(item.id)
                if jasna_job_id is None:
                    jasna_skipped = True
                    jasna_skip_reason = "jasna unavailable or enqueue skipped"
        return {
            "media_id": item.id,
            "item": _media_out(item),
            "duplicate": bool(reg.duplicate),
            "segments": len(tmp_paths),
            "note": "content_duplicate" if reg.duplicate else f"concat:{len(tmp_paths)}",
            "jasna_job_id": jasna_job_id,
            "jasna_skipped": jasna_skipped,
            "jasna_skip_reason": jasna_skip_reason,
        }
    finally:
        for p in tmp_paths:
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass


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
    t0 = time.perf_counter()
    vname = getattr(video, "filename", None) or "video"
    aname = getattr(audio, "filename", None) if audio is not None else None
    logger.info(
        "upload-av start title=%s src=%s v_name=%s has_audio=%s",
        _short(title, 80),
        _short(source_url, 140),
        _short(str(vname), 60),
        audio is not None,
    )
    try:
        vdata = await video.read()
        adata = await audio.read() if audio is not None else b""
    except Exception:
        logger.exception("upload-av read body failed title=%s", _short(title, 80))
        raise
    v_bytes, a_bytes = len(vdata), len(adata)
    logger.info(
        "upload-av received v_bytes=%s a_bytes=%s total=%s",
        v_bytes,
        a_bytes,
        v_bytes + a_bytes,
    )
    if settings.max_file_bytes and (v_bytes + a_bytes) > settings.max_file_bytes:
        logger.warning(
            "upload-av too large total=%s max=%s",
            v_bytes + a_bytes,
            settings.max_file_bytes,
        )
        raise HTTPException(400, "File too large")
    if v_bytes < 32:
        logger.warning("upload-av empty video title=%s", _short(title, 80))
        raise HTTPException(400, "Empty video track")

    v_tmp = None
    a_tmp = None
    try:
        v_tmp = write_temp_bytes(vdata, ".mp4")
        a_tmp = write_temp_bytes(adata, ".mp4") if adata and a_bytes > 32 else None
        fname = safe_filename(title or "capture", source_url or "capture", "mp4")
        dest = settings.medias_path() / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        t_merge = time.perf_counter()
        try:
            merge_av_to_mp4(v_tmp, a_tmp, dest)
            note = "merged"
            logger.info(
                "upload-av ffmpeg merge ok out_bytes=%s %.0fms",
                dest.stat().st_size if dest.is_file() else 0,
                (time.perf_counter() - t_merge) * 1000,
            )
        except Exception as e:
            logger.warning(
                "upload-av merge failed, fallback video_only: %s",
                e,
                exc_info=True,
            )
            dest.write_bytes(vdata)
            dest = remux_to_playable(dest, prefer_ext="mp4")
            note = f"video_only:{e}"
        reg = register_uploaded_file(
            category="default",
            dest=dest,
            title=title or "capture",
            source_url=source_url,
            media_type="video",
            mime="video/mp4",
            dedupe=False,
            tags=apply_restricted_flag(tags, _flag_true(restricted)),
        )
        item = reg.item
        if reg.duplicate:
            note = (note + ";content_duplicate") if note else "content_duplicate"
        jasna_job_id = None
        jasna_skipped = False
        jasna_skip_reason = ""
        if not reg.duplicate and _flag_true(use_jasna):
            if not bool(getattr(settings, "jasna_enabled", False)):
                jasna_skipped = True
                jasna_skip_reason = (
                    "server jasna disabled; demosaic via local JasnaBridge then re-upload"
                )
            else:
                jasna_job_id = enqueue_jasna_for_media(item.id)
                if jasna_job_id is None:
                    jasna_skipped = True
                    jasna_skip_reason = "jasna unavailable or enqueue skipped"
        ms = (time.perf_counter() - t0) * 1000
        logger.info(
            "upload-av ok media_id=%s note=%s dup=%s v=%s a=%s out=%s %.0fms",
            item.id,
            _short(note, 120),
            bool(reg.duplicate),
            v_bytes,
            a_bytes,
            getattr(item, "file_size", None),
            ms,
        )
        return {
            "media_id": item.id,
            "item": _media_out(item),
            "duplicate": bool(reg.duplicate),
            "note": note,
            "jasna_job_id": jasna_job_id,
            "jasna_skipped": jasna_skipped,
            "jasna_skip_reason": jasna_skip_reason,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception(
            "upload-av failed title=%s v_bytes=%s a_bytes=%s",
            _short(title, 80),
            v_bytes,
            a_bytes,
        )
        raise
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


@router.post("/media/{media_id}/file", dependencies=[Depends(require_token)])
async def media_replace_file(media_id: int, file: UploadFile = File(...)):
    """
    Replace the on-disk file for an existing video. Same media id.
    Used after local JasnaBridge demosaic. Tags, likes, series, and
    playback position are left on the row.
    """
    settings = get_settings()
    work = settings.tmp_path() / "replace" / str(int(media_id))
    work.mkdir(parents=True, exist_ok=True)
    raw_name = file.filename or "replace.mp4"
    dest = work / "incoming.bin"
    if dest.exists():
        dest.unlink(missing_ok=True)
    max_bytes = int(settings.max_file_bytes or 0)
    written = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if max_bytes and written > max_bytes:
                    raise HTTPException(400, "File too large")
                out.write(chunk)
        item = replace_library_video(int(media_id), dest, upload_name=raw_name)
    except ReplaceFileError as e:
        raise HTTPException(e.status_code, str(e)) from e
    finally:
        dest.unlink(missing_ok=True)
    return {"ok": True, "media_id": item.id, "item": _media_out(item)}


@router.post("/media/{media_id}/reencode", dependencies=[Depends(require_token)])
def media_reencode_h264(media_id: int):
    """
    Force H.264/AAC progressive MP4 re-encode for one library video, then replace
    the on-disk file (same media id). Used by manage-page「修复」button.
    """
    try:
        item = reencode_replace_h264(int(media_id))
    except ReencodeError as e:
        raise HTTPException(e.status_code, str(e)) from e
    return {"ok": True, "item": _media_out(item)}


@router.post("/media/{media_id}/jasna", dependencies=[Depends(require_token)])
def media_enqueue_jasna(media_id: int, db=Depends(get_db)):
    m = db.get(MediaItem, media_id)
    if not m:
        raise HTTPException(404, "Not found")
    if not bool(getattr(get_settings(), "jasna_enabled", False)):
        raise HTTPException(
            400,
            "Server jasna disabled. Use local JasnaBridge middleware for demosaic.",
        )
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


# —— DLNA cast (discover + push file URL to MediaRenderer) ——


@router.get("/dlna/devices", dependencies=[Depends(require_token)])
def dlna_devices(
    refresh: bool = Query(
        default=False,
        description="Force SSDP rescan; default uses last scan (instant after first)",
    ),
    timeout: float = Query(default=2.5, ge=1.0, le=8.0),
):
    """List LAN DLNA / UPnP MediaRenderer devices (AVTransport)."""
    from app.services import dlna as dlna_svc

    try:
        return dlna_svc.list_devices(timeout_sec=float(timeout), force=bool(refresh))
    except Exception as e:
        logger.exception("dlna discover failed")
        raise HTTPException(500, f"DLNA discover failed: {e}") from e


@router.post("/dlna/play", dependencies=[Depends(require_token)])
def dlna_play(body: DlnaPlayRequest, request: Request, db=Depends(get_db)):
    """
    Push library media file URL to a DLNA renderer (SetAVTransportURI + Play).
    Box fetches /api/media/{id}/file?token=… over LAN — no webpage on the TV.
    """
    from app.services import dlna as dlna_svc
    from urllib.parse import quote

    m = db.get(MediaItem, int(body.media_id))
    if not m:
        raise HTTPException(404, "Media not found")
    path = get_settings().medias_path() / m.rel_path
    if not path.is_file():
        raise HTTPException(404, "File missing on disk")

    device = dlna_svc.find_device(body.device_id, rescan=True)
    if not device:
        raise HTTPException(404, "DLNA device not found; refresh the list")

    s = get_settings()
    base = dlna_svc.public_base_url_from_request(
        host_header=request.headers.get("host"),
        scheme=request.url.scheme or "http",
        server_port=int(s.port),
    )
    ver = _media_cache_ver(m)
    file_path = f"/api/media/{m.id}/file?v={ver}"
    token = (s.access_token or "").strip()
    if token:
        file_path += f"&token={quote(token, safe='')}"
    uri = f"{base}{file_path}"

    mime = m.mime or ""
    if not mime:
        import mimetypes as _mt

        mime = _mt.guess_type(path.name)[0] or "video/mp4"
    mtype = (m.media_type or "video").lower()
    title = (m.title or path.name or f"media-{m.id}").strip()

    mode = dlna_svc.normalize_play_mode(getattr(body, "mode", None))

    try:
        dlna_svc.cast_uri(
            device,
            uri=uri,
            title=title,
            mime=mime,
            media_type=mtype,
        )
    except Exception as e:
        logger.exception("dlna play failed device=%s media=%s", body.device_id, body.media_id)
        raise HTTPException(502, f"Cast failed: {e}") from e

    sess = dlna_svc.start_cast_session(
        device,
        media_id=int(m.id),
        mode=mode,
        uri=uri,
        title=title,
        mime=mime,
        media_type=mtype,
    )

    return {
        "ok": True,
        "device": device.to_dict(),
        "media_id": m.id,
        "uri": uri,
        "title": title,
        "mode": sess.mode,
    }


@router.post("/dlna/seek", dependencies=[Depends(require_token)])
def dlna_seek(body: DlnaSeekRequest):
    """
    Seek the active AVTransport on a DLNA renderer (phone scrub → TV sync).
    Requires the box to still be playing the cast URI from /dlna/play.
    """
    from app.services import dlna as dlna_svc

    pos = float(body.position_sec)
    if pos < 0:
        pos = 0.0
    if pos > 3600 * 99:
        raise HTTPException(400, "position_sec out of range")

    device = dlna_svc.resolve_device(body.device_id)
    if not device:
        raise HTTPException(404, "DLNA device not found; open cast list and refresh")

    try:
        target = dlna_svc.seek_position(device, pos)
    except Exception as e:
        logger.exception("dlna seek failed device=%s pos=%s", body.device_id, pos)
        raise HTTPException(502, f"Seek failed: {e}") from e

    dlna_svc.touch_cast_session_grace(device.id)

    return {
        "ok": True,
        "device_id": device.id,
        "position_sec": pos,
        "target": target,
    }


@router.post("/dlna/control", dependencies=[Depends(require_token)])
def dlna_control(body: DlnaControlRequest):
    """
    Pause / resume / stop the active cast on a DLNA renderer.
    Stop ends the session on most boxes (back to idle / home).
    """
    from app.services import dlna as dlna_svc

    action = (body.action or "").strip().lower()
    if action not in ("pause", "play", "stop", "volume", "get_volume"):
        raise HTTPException(400, "action must be pause, play, stop, volume, or get_volume")

    device = dlna_svc.resolve_device(body.device_id)
    if not device:
        raise HTTPException(404, "DLNA device not found; open cast list and refresh")

    try:
        if action == "pause":
            dlna_svc.pause_device(device)
            dlna_svc.set_cast_session_paused(device.id, True)
        elif action == "play":
            dlna_svc.play_device(device)
            dlna_svc.set_cast_session_paused(device.id, False)
        elif action == "volume":
            vol = dlna_svc.set_volume(device, body.volume)
            return {
                "ok": True,
                "device_id": device.id,
                "action": action,
                "volume": vol,
                "device": device.to_dict(),
            }
        elif action == "get_volume":
            vol = dlna_svc.get_volume(device)
            return {
                "ok": True,
                "device_id": device.id,
                "action": action,
                "volume": vol,
                "device": device.to_dict(),
            }
        else:
            # Clear loop session before Stop so watcher does not re-cast
            dlna_svc.clear_cast_session(device.id)
            dlna_svc.stop_device(device)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        logger.exception("dlna control failed device=%s action=%s", body.device_id, action)
        if action == "stop":
            # Still drop session if Stop SOAP failed after clear, or clear if before
            dlna_svc.clear_cast_session(device.id)
        raise HTTPException(502, f"Control {action} failed: {e}") from e

    return {
        "ok": True,
        "device_id": device.id,
        "action": action,
        "device": device.to_dict(),
    }
