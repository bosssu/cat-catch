from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import DownloadJob, MediaItem
from app.services.dash import DashError, download_dash
from app.services.hls import HlsError, download_hls
from app.services.thumb import generate_thumb
from app.services.util import (
    detect_media_type,
    guess_ext,
    is_probably_html,
    job_payload_json,
    parse_job_payload,
    safe_category,
    clip_disambiguator,
    ensure_unique_path,
    media_url_hash,
    normalize_clip_bounds,
    safe_filename,
    url_hash,
)

logger = logging.getLogger("lmw.download")

_worker_task: asyncio.Task | None = None
_sem: asyncio.Semaphore | None = None
_running_tasks: set[asyncio.Task] = set()
_cancel_flags: set[int] = set()

# multi-connection direct download thresholds
_RANGE_MIN_BYTES = 2 * 1024 * 1024  # only shard files >= 2MB


def request_cancel(job_id: int) -> None:
    _cancel_flags.add(job_id)


def _is_cancelled(job_id: int) -> bool:
    return job_id in _cancel_flags


async def start_worker() -> None:
    global _worker_task, _sem
    settings = get_settings()
    try:
        from app.services.http_client import describe_network_setup

        logger.info("download network modes: %s", describe_network_setup(settings))
    except Exception as e:
        logger.warning("network setup probe failed: %s", e)
    _sem = asyncio.Semaphore(max(1, int(settings.download_concurrency or 1)))
    # recover stuck jobs
    with session_scope() as db:
        rows = db.scalars(select(DownloadJob).where(DownloadJob.status == "running")).all()
        for j in rows:
            work = get_settings().tmp_path() / "jobs" / str(j.id) / "segments.json"
            if j.media_type == "m3u8" and work.is_file():
                j.status = "queued"
                j.error_message = "Resumed after restart"
            else:
                j.status = "failed_network"
                j.error_message = "Interrupted by restart"
                j.client_fallback_allowed = True
        db.commit()
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_loop())


async def _loop() -> None:
    while True:
        try:
            await _pump()
        except Exception:
            logger.exception("worker loop error")
        await asyncio.sleep(0.25)


async def _job_wrapper(job_id: int) -> None:
    assert _sem is not None
    try:
        async with _sem:
            await _run_job(job_id)
    except Exception:
        logger.exception("job wrapper %s crashed", job_id)
        try:
            _finish_fail(job_id, "failed_network", 0, "Worker crash", True)
        except Exception:
            pass


async def _pump() -> None:
    """Dispatch up to download_concurrency jobs in parallel (non-blocking)."""
    # drop finished tasks
    done = {t for t in _running_tasks if t.done()}
    for t in done:
        _running_tasks.discard(t)
        try:
            exc = t.exception()
            if exc:
                logger.debug("task ended with error: %s", exc)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    assert _sem is not None
    settings = get_settings()
    cap = max(1, int(settings.download_concurrency or 1))
    slots = cap - len(_running_tasks)
    if slots <= 0:
        return

    for _ in range(slots):
        with session_scope() as db:
            job = db.scalars(
                select(DownloadJob)
                .where(DownloadJob.status == "queued")
                .order_by(DownloadJob.id.asc())
                .limit(1)
            ).first()
            if not job:
                return
            job_id = job.id
            job.status = "running"
            db.commit()

        task = asyncio.create_task(_job_wrapper(job_id), name=f"lmw-job-{job_id}")
        _running_tasks.add(task)


async def enqueue_jobs(
    category: str,
    items: list[dict],
    default_tags: list | None = None,
) -> dict:
    """Create jobs; return accepted/duplicates/job_ids/duplicate_media_ids.

    category is kept for hash compatibility but new files store flat under Medias/.
    """
    from app.services.tags import normalize_tags, tags_to_json

    cat = "default"  # flat library; ignore client category folders
    get_settings().medias_path().mkdir(parents=True, exist_ok=True)
    job_ids: list[int] = []
    duplicates: list[int] = []
    accepted = 0
    top_tags = normalize_tags(default_tags or [])

    with session_scope() as db:
        for it in items:
            url = (it.get("url") or "").strip()
            if not url or url.startswith("file:"):
                continue

            media_type = detect_media_type(url, None, it.get("media_type"))
            headers = dict(it.get("headers") or {})
            if it.get("referer") and "Referer" not in headers and "referer" not in headers:
                headers["Referer"] = it["referer"]
            if it.get("source_page") and "Referer" not in headers:
                headers["Referer"] = it["source_page"]

            start_sec, end_sec = normalize_clip_bounds(
                it.get("start_sec"), it.get("end_sec")
            )
            # Different clip ranges of same m3u8 are distinct; same range → 重复
            uh = media_url_hash(url, cat, start_sec, end_sec)

            existing = db.scalars(
                select(MediaItem).where(MediaItem.url_hash == uh)
            ).first()
            if existing:
                duplicates.append(existing.id)
                # merge tags if client sent some
                item_tags = normalize_tags(it.get("tags") or top_tags)
                if item_tags:
                    from app.services.tags import tags_from_json

                    merged = normalize_tags(tags_from_json(existing.tags_json) + item_tags)
                    existing.tags_json = tags_to_json(merged)
                continue
            # also skip active jobs for same url+range
            active = db.scalars(
                select(DownloadJob).where(
                    DownloadJob.url_hash == uh,
                    DownloadJob.status.in_(("queued", "running")),
                )
            ).first()
            if active:
                job_ids.append(active.id)
                continue

            item_tags = normalize_tags(it.get("tags") if it.get("tags") is not None else top_tags)
            job = DownloadJob(
                category=cat,
                url=url,
                media_type=media_type,
                title=(it.get("title") or "")[:512],
                source_page=(it.get("source_page") or it.get("referer") or "")[:2048],
                headers_json=job_payload_json(headers, start_sec, end_sec),
                tags_json=tags_to_json(item_tags),
                status="queued",
                url_hash=uh,
                client_fallback_allowed=True,
            )
            db.add(job)
            db.flush()
            job_ids.append(job.id)
            accepted += 1
        db.commit()

    return {
        "job_ids": job_ids,
        "accepted": accepted,
        "duplicates": len(duplicates),
        "duplicate_media_ids": duplicates,
    }


async def _run_job(job_id: int) -> None:
    settings = get_settings()
    with session_scope() as db:
        job = db.get(DownloadJob, job_id)
        if not job:
            return
        url = job.url
        headers, start_sec, end_sec = parse_job_payload(job.headers_json)
        if "User-Agent" not in headers and "user-agent" not in headers:
            headers["User-Agent"] = settings.user_agent
        cat = job.category
        title = job.title
        media_type = job.media_type
        uh = job.url_hash
        source_page = job.source_page

    if _is_cancelled(job_id):
        _finish_fail(job_id, "cancelled", 0, "Cancelled", False)
        _cancel_flags.discard(job_id)
        return

    try:
        path_l = url.lower().split("?")[0]
        if media_type == "dash" or path_l.endswith(".mpd") or "/dash_" in path_l:
            await _run_dash(job_id, url, headers, cat, title, uh, source_page)
        elif media_type == "m3u8" or path_l.endswith(".m3u8"):
            await _run_m3u8(
                job_id,
                url,
                headers,
                cat,
                title,
                uh,
                source_page,
                start_sec=start_sec,
                end_sec=end_sec,
            )
        else:
            await _run_direct(job_id, url, headers, cat, title, media_type, uh, source_page)
    except httpx.RequestError as e:
        logger.warning("job %s network error: %s", job_id, e)
        _finish_fail(
            job_id,
            "failed_network",
            0,
            f"{type(e).__name__}: {e}"[:1000],
            True,
        )
    except Exception as e:
        logger.exception("job %s failed", job_id)
        msg = str(e)
        # Path/DB collisions are local logic bugs, not CDN failures
        if "UNIQUE constraint" in msg or "IntegrityError" in type(e).__name__:
            _finish_fail(job_id, "failed_disk", 0, msg[:1000], False)
        else:
            _finish_fail(job_id, "failed_network", 0, msg[:1000], True)


async def _stream_to_file(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    dest: Path,
) -> tuple[int, str | None, bytes]:
    """Stream full GET to dest. Returns (status, content-type, first_bytes)."""
    first = b""
    async with client.stream("GET", url, headers=headers) as r:
        if r.status_code >= 400:
            return r.status_code, r.headers.get("content-type"), b""
        ct = r.headers.get("content-type")
        with dest.open("wb") as f:
            async for chunk in r.aiter_bytes(chunk_size=256 * 1024):
                if not first:
                    first = chunk[:200]
                f.write(chunk)
        return r.status_code, ct, first


async def _download_multi_range(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    dest: Path,
    total: int,
    connections: int,
) -> None:
    """Parallel Range GETs then assemble."""
    n = max(1, min(connections, 16))
    part = (total + n - 1) // n
    ranges: list[tuple[int, int, Path]] = []
    tmp_dir = dest.parent / (dest.name + ".parts")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    async def one(i: int, start: int, end: int, path: Path) -> None:
        h = dict(headers)
        h["Range"] = f"bytes={start}-{end}"
        async with client.stream("GET", url, headers=h) as r:
            if r.status_code not in (200, 206):
                raise httpx.HTTPError(f"Range {start}-{end} HTTP {r.status_code}")
            with path.open("wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=256 * 1024):
                    f.write(chunk)

    tasks = []
    for i in range(n):
        start = i * part
        if start >= total:
            break
        end = min(total - 1, (i + 1) * part - 1)
        p = tmp_dir / f"p{i:02d}"
        ranges.append((start, end, p))
        tasks.append(one(i, start, end, p))
    try:
        await asyncio.gather(*tasks)
        with dest.open("wb") as out:
            for _, _, p in ranges:
                with p.open("rb") as inp:
                    shutil.copyfileobj(inp, out, length=1024 * 1024)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


async def _run_direct(
    job_id: int,
    url: str,
    headers: dict[str, str],
    cat: str,
    title: str,
    media_type: str,
    uh: str,
    source_page: str,
) -> None:
    settings = get_settings()
    timeout = httpx.Timeout(settings.request_timeout_sec, connect=30.0)
    work = settings.tmp_path() / "jobs" / str(job_id)
    work.mkdir(parents=True, exist_ok=True)
    tmp_path = work / "download.bin"

    from app.services.http_client import iter_http_modes

    # Pick first network mode that can reach the URL (HEAD or GET probe)
    last_net_err: Exception | None = None
    chosen_kwargs: dict | None = None
    for mode in iter_http_modes(settings):
        try:
            kw = mode.client_kwargs(settings, timeout=timeout)
            async with httpx.AsyncClient(**kw) as probe:
                pr = await probe.head(url, headers=headers)
                if pr.status_code >= 500:
                    raise httpx.ConnectError(f"HEAD {pr.status_code}")
            chosen_kwargs = kw
            break
        except httpx.RequestError as e:
            last_net_err = e
            continue
    if chosen_kwargs is None:
        # still try first mode for full GET (some hosts block HEAD)
        modes = list(iter_http_modes(settings))
        if not modes:
            raise httpx.ConnectError(str(last_net_err or "no http modes"))
        chosen_kwargs = modes[0].client_kwargs(settings, timeout=timeout)

    async with httpx.AsyncClient(**chosen_kwargs) as client:
        hdrs = dict(headers)
        status = 0
        ct: str | None = None
        first = b""
        used_multi = False

        # Probe size / Accept-Ranges for multi-connection
        size = 0
        accept_ranges = False
        try:
            hr = await client.head(url, headers=hdrs)
            if hr.status_code in (401, 403) and source_page:
                hdrs = dict(headers)
                hdrs["Referer"] = source_page
                hr = await client.head(url, headers=hdrs)
            if hr.status_code < 400:
                cl = hr.headers.get("content-length")
                if cl and cl.isdigit():
                    size = int(cl)
                ar = (hr.headers.get("accept-ranges") or "").lower()
                accept_ranges = ar == "bytes" or "bytes" in ar
                ct = hr.headers.get("content-type")
        except httpx.HTTPError:
            pass

        connections = max(1, int(getattr(settings, "direct_connections", 4) or 1))
        used_gopeed = False
        gopeed_min = int(getattr(settings, "gopeed_min_bytes", 5 * 1024 * 1024) or 0)
        try_gopeed = (
            bool(getattr(settings, "gopeed_enabled", False))
            and size >= gopeed_min
            and size > 0
            and (not settings.max_file_bytes or size <= settings.max_file_bytes)
            and media_type not in ("m3u8", "dash")
        )

        if try_gopeed:
            from app.services.gopeed import download_with_gopeed, resolve_gopeed_path

            if resolve_gopeed_path(getattr(settings, "gopeed_path", "") or ""):

                async def _gp_progress(pct: float, done: int, total: int) -> None:
                    with session_scope() as db:
                        job = db.get(DownloadJob, job_id)
                        if job:
                            job.progress = float(pct)
                            db.commit()

                gdir = work / "gopeed"
                try:
                    gpath = await download_with_gopeed(
                        url,
                        gdir,
                        expected_size=size,
                        job_id=job_id,
                        is_cancelled=_is_cancelled,
                        progress_cb=_gp_progress,
                    )
                    if _is_cancelled(job_id):
                        _finish_fail(job_id, "cancelled", 0, "Cancelled", False)
                        _cancel_flags.discard(job_id)
                        return
                    # Normalize to tmp_path for shared post-processing
                    if tmp_path.exists():
                        tmp_path.unlink(missing_ok=True)
                    shutil.move(str(gpath), str(tmp_path))
                    shutil.rmtree(gdir, ignore_errors=True)
                    used_gopeed = True
                    status = 200
                    with tmp_path.open("rb") as f:
                        first = f.read(200)
                    logger.info(
                        "job %s gopeed ok size=%s",
                        job_id,
                        tmp_path.stat().st_size,
                    )
                except Exception as e:
                    logger.info("job %s gopeed failed (%s), fallback httpx", job_id, e)
                    shutil.rmtree(gdir, ignore_errors=True)
                    tmp_path.unlink(missing_ok=True)
                    used_gopeed = False

        try:
            if used_gopeed:
                pass  # already have tmp_path
            elif (
                connections > 1
                and size >= _RANGE_MIN_BYTES
                and accept_ranges
                and (not settings.max_file_bytes or size <= settings.max_file_bytes)
            ):
                await _download_multi_range(client, url, hdrs, tmp_path, size, connections)
                used_multi = True
                status = 200
                if tmp_path.is_file():
                    with tmp_path.open("rb") as f:
                        first = f.read(200)
            else:
                status, ct2, first = await _stream_to_file(client, url, hdrs, tmp_path)
                ct = ct or ct2
                if status in (401, 403) and source_page:
                    hdrs2 = dict(headers)
                    hdrs2["Referer"] = source_page
                    status, ct, first = await _stream_to_file(client, url, hdrs2, tmp_path)
        except httpx.HTTPError as e:
            # multi-range fail → single stream fallback
            if used_multi or connections > 1:
                logger.info("job %s multi-range failed (%s), fallback single", job_id, e)
                try:
                    status, ct, first = await _stream_to_file(client, url, hdrs, tmp_path)
                except httpx.HTTPError as e2:
                    _finish_fail(job_id, "failed_network", 0, str(e2)[:500], True)
                    return
            else:
                _finish_fail(job_id, "failed_network", 0, str(e)[:500], True)
                return

        if status in (401, 403):
            _finish_fail(job_id, "failed_auth", status, f"HTTP {status}", True)
            return
        if status >= 400:
            _finish_fail(job_id, "failed_network", status, f"HTTP {status}", True)
            return

        if not tmp_path.is_file() or tmp_path.stat().st_size == 0:
            _finish_fail(job_id, "failed_network", status, "Empty download", True)
            return

        if is_probably_html(ct, first):
            _finish_fail(job_id, "failed_auth", status, "Got HTML instead of media", True)
            return

        fsize = tmp_path.stat().st_size
        if settings.max_file_bytes and fsize > settings.max_file_bytes:
            tmp_path.unlink(missing_ok=True)
            _finish_fail(job_id, "failed_disk", 0, "File exceeds max_file_bytes", False)
            return

        mtype = detect_media_type(url, ct, media_type)
        ext = guess_ext(url, ct, mtype)
        fname = safe_filename(title, url, ext)
        dest_dir = settings.medias_path()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = ensure_unique_path(dest_dir / fname)
        shutil.move(str(tmp_path), str(dest))
        if used_gopeed:
            warn = "gopeed"
        elif used_multi:
            warn = "multi-range"
        else:
            warn = ""
        await _register_media(
            job_id,
            cat=cat,
            title=title or dest.stem,
            media_type=mtype,
            dest=dest,
            source_url=url,
            uh=uh,
            mime=ct or "",
            partial=False,
            warning=warn,
        )
        try:
            shutil.rmtree(work, ignore_errors=True)
        except Exception:
            pass


async def _run_m3u8(
    job_id: int,
    url: str,
    headers: dict[str, str],
    cat: str,
    title: str,
    uh: str,
    source_page: str,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> None:
    # Misrouted DASH (old client labeled .mpd as m3u8)
    if url.lower().split("?")[0].endswith(".mpd") or (
        "dash" in url.lower() and ".mpd" in url.lower()
    ):
        await _run_dash(job_id, url, headers, cat, title, uh, source_page)
        return

    settings = get_settings()
    work = settings.tmp_path() / "jobs" / str(job_id)
    out = work / "output.mp4"

    # CDN often requires page Referer / Origin (e.g. eporner)
    if "Referer" not in headers and "referer" not in headers:
        if source_page:
            headers = {**headers, "Referer": source_page}
        else:
            try:
                from urllib.parse import urlparse

                p = urlparse(url)
                if p.scheme and p.netloc:
                    headers = {**headers, "Referer": f"{p.scheme}://{p.netloc}/"}
            except Exception:
                pass
    if "Origin" not in headers and "origin" not in headers:
        ref = headers.get("Referer") or headers.get("referer") or ""
        if ref:
            try:
                from urllib.parse import urlparse

                p = urlparse(ref)
                if p.scheme and p.netloc:
                    headers = {**headers, "Origin": f"{p.scheme}://{p.netloc}"}
            except Exception:
                pass

    async def progress_cb(done: int, total: int) -> None:
        with session_scope() as db:
            job = db.get(DownloadJob, job_id)
            if job:
                job.segments_done = done
                job.segments_total = total
                job.progress = (done / total * 100.0) if total else 0
                db.commit()

    try:
        meta = await download_hls(
            url,
            headers,
            work,
            out,
            progress_cb=progress_cb,
            start_sec=start_sec,
            end_sec=end_sec,
        )
    except HlsError as e:
        err = str(e)
        status = "failed_auth" if e.http_status in (401, 403) else "failed_partial"
        if "Missing" in err:
            status = "failed_partial"
        if "connect" in err.lower() or "ConnectError" in err:
            status = "failed_network"
        if e.need_client:
            _finish_fail(
                job_id,
                status if e.http_status else (
                    "failed_network" if status == "failed_network" else "need_client_fetch"
                ),
                e.http_status,
                err[:1000],
                True,
            )
        else:
            _finish_fail(job_id, status, e.http_status, err[:1000], True)
        return

    out_file: Path = meta["out_file"]
    # Same m3u8 URL + different clips must not share one dest / rel_path
    clip_key = clip_disambiguator(start_sec, end_sec)
    fname = safe_filename(
        title, url, out_file.suffix.lstrip(".") or "mp4", disambiguator=clip_key
    )
    dest = settings.medias_path() / fname
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = ensure_unique_path(dest)
    shutil.move(str(out_file), str(dest))
    display_title = title or dest.stem
    if clip_key and title:
        display_title = f"{title} [{clip_key}]"
    await _register_media(
        job_id,
        cat=cat,
        title=display_title,
        media_type="video",
        dest=dest,
        source_url=url,
        uh=uh,
        mime="video/mp4",
        partial=bool(meta.get("partial")),
        warning=str(meta.get("warning") or ""),
    )
    # cleanup work dir on success
    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass


async def _run_dash(
    job_id: int,
    url: str,
    headers: dict[str, str],
    cat: str,
    title: str,
    uh: str,
    source_page: str,
) -> None:
    """Steam store trailers etc. — MPEG-DASH MPD with SegmentTemplate."""
    settings = get_settings()
    work = settings.tmp_path() / "jobs" / str(job_id)
    out = work / "output.mp4"

    # Ensure Referer for CDN (Steam Fastly often needs store referer)
    if "Referer" not in headers and "referer" not in headers:
        if source_page:
            headers = {**headers, "Referer": source_page}
        elif "steam" in url.lower():
            headers = {**headers, "Referer": "https://store.steampowered.com/"}

    async def progress_cb(done: int, total: int) -> None:
        with session_scope() as db:
            job = db.get(DownloadJob, job_id)
            if job:
                job.segments_done = done
                job.segments_total = total
                job.progress = (done / total * 100.0) if total else 0
                db.commit()

    try:
        meta = await download_dash(url, headers, work, out, progress_cb=progress_cb)
    except DashError as e:
        status = "failed_auth" if e.http_status in (401, 403) else "failed_partial"
        if e.need_client:
            _finish_fail(
                job_id,
                status if e.http_status else "need_client_fetch",
                e.http_status,
                str(e),
                True,
            )
        else:
            _finish_fail(job_id, status, e.http_status, str(e), False)
        return

    out_file: Path = meta["out_file"]
    fname = safe_filename(title, url, out_file.suffix.lstrip(".") or "mp4")
    dest = settings.medias_path() / fname
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = ensure_unique_path(dest)
    shutil.move(str(out_file), str(dest))
    warn = str(meta.get("warning") or "")
    if meta.get("bandwidth"):
        extra = f"dash rep={meta.get('video_rep')} bw={meta.get('bandwidth')}"
        warn = f"{warn}; {extra}".strip("; ")
    await _register_media(
        job_id,
        cat=cat,
        title=title or dest.stem,
        media_type="video",
        dest=dest,
        source_url=url,
        uh=uh,
        mime="video/mp4",
        partial=bool(meta.get("partial")),
        warning=warn,
    )
    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass


async def _register_media(
    job_id: int,
    *,
    cat: str,
    title: str,
    media_type: str,
    dest: Path,
    source_url: str,
    uh: str,
    mime: str,
    partial: bool,
    warning: str,
) -> None:
    settings = get_settings()
    # Flat layout: rel_path is filename only (legacy rows may still be cat/name)
    rel = dest.name
    try:
        rel = dest.resolve().relative_to(settings.medias_path().resolve()).as_posix()
    except Exception:
        rel = dest.name
    with session_scope() as db:
        job = db.get(DownloadJob, job_id)
        tags_json = (job.tags_json if job and getattr(job, "tags_json", None) else None) or "[]"
        item = MediaItem(
            category="default",
            title=title[:512],
            media_type=media_type if media_type != "m3u8" else "video",
            rel_path=rel,
            source_url=source_url[:2048],
            url_hash=uh,
            file_size=dest.stat().st_size if dest.is_file() else 0,
            mime=mime or "",
            partial=partial,
            warning=warning or "",
            tags_json=tags_json,
        )
        db.add(item)
        db.flush()
        media_id = item.id
        if job:
            job.status = "success"
            job.media_id = media_id
            job.progress = 100
            job.error_message = warning or ""
            job.headers_json = "{}"  # drop secrets
        db.commit()

    thumb_rel = await asyncio.to_thread(
        generate_thumb, dest, media_id, media_type if media_type != "m3u8" else "video"
    )
    if thumb_rel:
        with session_scope() as db:
            item = db.get(MediaItem, media_id)
            if item:
                item.thumb_rel = thumb_rel
                db.commit()


def _finish_fail(
    job_id: int,
    status: str,
    http_status: int,
    message: str,
    client_fallback: bool,
) -> None:
    with session_scope() as db:
        job = db.get(DownloadJob, job_id)
        if not job:
            return
        job.status = status
        job.http_status = http_status
        job.error_message = message[:2000]
        job.client_fallback_allowed = client_fallback
        if status in ("failed_auth", "need_client_fetch", "failed_partial", "failed_network"):
            job.client_fallback_allowed = client_fallback
        db.commit()


def register_uploaded_file(
    *,
    category: str,
    dest: Path,
    title: str,
    source_url: str,
    media_type: str,
    mime: str,
    dedupe: bool = False,
    tags: list | None = None,
) -> MediaItem:
    """
    Register a file already written under Medias/.

    Uploads from extension capture must use dedupe=False: same page URL is reused
    for every capture and would otherwise collapse to the first row (unplayable).
    """
    from app.services.tags import normalize_tags, tags_from_json, tags_to_json

    settings = get_settings()
    try:
        rel = dest.resolve().relative_to(settings.medias_path().resolve()).as_posix()
    except Exception:
        rel = dest.name
    size = dest.stat().st_size if dest.is_file() else 0
    # Unique per file path + size so re-uploads never clobber DB identity
    uh = url_hash(f"upload|{rel}|{size}|{source_url or ''}", "default")
    tag_json = tags_to_json(tags or [])
    with session_scope() as db:
        existing = None
        if dedupe and source_url:
            existing = db.scalars(
                select(MediaItem).where(MediaItem.url_hash == uh)
            ).first()
        if not existing:
            existing = db.scalars(select(MediaItem).where(MediaItem.rel_path == rel)).first()
        if existing:
            existing.file_size = size
            existing.mime = mime or existing.mime
            existing.title = (title or existing.title or dest.stem)[:512]
            if tags:
                merged = normalize_tags(tags_from_json(existing.tags_json) + list(tags))
                existing.tags_json = tags_to_json(merged)
            db.commit()
            db.refresh(existing)
            media_id = existing.id
            mtype = existing.media_type or media_type
            dest_for_thumb = dest
        else:
            item = MediaItem(
                category="default",
                title=(title or dest.stem)[:512],
                media_type=media_type,
                rel_path=rel,
                source_url=(source_url or "")[:2048],
                url_hash=uh,
                file_size=size,
                mime=mime or "",
                tags_json=tag_json,
            )
            db.add(item)
            db.commit()
            db.refresh(item)
            media_id = item.id
            mtype = media_type
            dest_for_thumb = dest

    thumb_rel = generate_thumb(dest_for_thumb, media_id, mtype)
    if thumb_rel:
        with session_scope() as db:
            item = db.get(MediaItem, media_id)
            if item:
                item.thumb_rel = thumb_rel
                db.commit()
                db.refresh(item)
                return item
    with session_scope() as db:
        return db.get(MediaItem, media_id)
