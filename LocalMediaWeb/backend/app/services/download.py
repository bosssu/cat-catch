from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
from pathlib import Path

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import DownloadJob, MediaItem
from app.services.dash import DashError, download_dash
from app.services.hls import HlsError, download_hls
from app.services.media_process import IosCodecError
from app.services.thumb import generate_thumb
from app.services.dedupe import find_item_by_content, hash_media_file
from app.services.util import (
    detect_media_type,
    guess_ext,
    is_probably_html,
    job_payload_json,
    job_allows_ios_incompatible,
    parse_job_payload,
    safe_category,
    clip_disambiguator,
    ensure_unique_path,
    live_stream_reject_reason,
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

    settings = get_settings()
    rejected_live = 0
    rejected_live_reasons: list[str] = []

    with session_scope() as db:
        for it in items:
            url = (it.get("url") or "").strip()
            if not url or url.startswith("file:"):
                continue

            if bool(getattr(settings, "block_live_streams", True)):
                live_why = live_stream_reject_reason(url)
                if live_why:
                    rejected_live += 1
                    if len(rejected_live_reasons) < 5:
                        rejected_live_reasons.append(f"{live_why}: {url[:120]}")
                    logger.info("enqueue reject live/unbounded stream: %s | %s", live_why, url[:200])
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
            use_jasna = bool(
                it.get("use_jasna") is True
                or str(it.get("use_jasna") or "").strip().lower() in ("1", "true", "yes", "on")
            )
            allow_ios = bool(
                it.get("allow_ios_incompatible") is True
                or str(it.get("allow_ios_incompatible") or "").strip().lower()
                in ("1", "true", "yes", "on")
            )
            job = DownloadJob(
                category=cat,
                url=url,
                media_type=media_type,
                title=(it.get("title") or "")[:512],
                source_page=(it.get("source_page") or it.get("referer") or "")[:2048],
                headers_json=job_payload_json(
                    headers, start_sec, end_sec, allow_ios_incompatible=allow_ios
                ),
                tags_json=tags_to_json(item_tags),
                status="queued",
                url_hash=uh,
                client_fallback_allowed=True,
                use_jasna=use_jasna,
            )
            db.add(job)
            db.flush()
            job_ids.append(job.id)
            accepted += 1
            logger.info(
                "enqueue job=%s type=%s title=%s url=%s",
                job.id,
                media_type,
                (it.get("title") or "")[:80],
                url[:160],
            )
        db.commit()

    logger.info(
        "enqueue summary accepted=%s duplicates=%s rejected_live=%s job_ids=%s",
        accepted,
        len(duplicates),
        rejected_live,
        job_ids,
    )
    return {
        "job_ids": job_ids,
        "accepted": accepted,
        "duplicates": len(duplicates),
        "duplicate_media_ids": duplicates,
        "rejected_live": rejected_live,
        "rejected_live_samples": rejected_live_reasons,
    }


async def _run_job(job_id: int) -> None:
    settings = get_settings()
    with session_scope() as db:
        job = db.get(DownloadJob, job_id)
        if not job:
            return
        url = job.url
        headers, start_sec, end_sec = parse_job_payload(job.headers_json)
        allow_ios = job_allows_ios_incompatible(job.headers_json)
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

    logger.info(
        "job %s start type=%s title=%s url=%s",
        job_id,
        media_type,
        (title or "")[:80],
        (url or "")[:160],
    )
    try:
        path_l = url.lower().split("?")[0]
        if media_type == "dash" or path_l.endswith(".mpd") or "/dash_" in path_l:
            await _run_dash(
                job_id,
                url,
                headers,
                cat,
                title,
                uh,
                source_page,
                allow_ios_incompatible=allow_ios,
            )
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
                allow_ios_incompatible=allow_ios,
            )
        else:
            await _run_direct(
                job_id,
                url,
                headers,
                cat,
                title,
                media_type,
                uh,
                source_page,
                start_sec=start_sec,
                end_sec=end_sec,
                allow_ios_incompatible=allow_ios,
            )
    except IosCodecError as e:
        logger.warning("job %s codec reject: %s", job_id, e)
        _finish_fail(job_id, "failed_codec", 0, str(e)[:1000], False)
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
    *,
    max_bytes: int = 0,
    known_size: int = 0,
    job_id: int | None = None,
) -> tuple[int, str | None, bytes]:
    """
    Stream full GET to dest. Returns (status, content-type, first_bytes).

    When Content-Length is missing, enforce max_bytes (live FLV safety).
    When known_size/max_file cap is set, also stop early.
    """
    first = b""
    async with client.stream("GET", url, headers=headers) as r:
        if r.status_code >= 400:
            return r.status_code, r.headers.get("content-type"), b""
        ct = r.headers.get("content-type")
        cl_hdr = r.headers.get("content-length")
        declared = 0
        if cl_hdr and str(cl_hdr).isdigit():
            declared = int(cl_hdr)
        if known_size > 0:
            declared = declared or known_size

        # Live / unbounded: no length → hard cap
        cap = 0
        if declared > 0:
            if max_bytes > 0:
                cap = max_bytes
        else:
            cap = max_bytes if max_bytes > 0 else get_settings().effective_max_unknown_size_bytes()

        written = 0
        with dest.open("wb") as f:
            async for chunk in r.aiter_bytes(chunk_size=256 * 1024):
                if job_id is not None and _is_cancelled(job_id):
                    raise httpx.HTTPError("cancelled")
                if not first:
                    first = chunk[:200]
                if cap > 0 and written + len(chunk) > cap:
                    keep = cap - written
                    if keep > 0:
                        f.write(chunk[:keep])
                        written += keep
                    raise httpx.HTTPError(
                        f"download exceeded size cap ({cap} bytes); "
                        "likely live/unbounded stream or oversize file"
                    )
                f.write(chunk)
                written += len(chunk)
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


def _ffmpeg_cut_file(
    src: Path,
    dest: Path,
    *,
    start_sec: float | None,
    end_sec: float | None,
) -> Path:
    """
    Cut progressive media with ffmpeg (copy when possible).
    Used so multi-range clips of the same direct URL become distinct files.
    """
    from app.core.config import ffmpeg_available

    if not ffmpeg_available():
        raise RuntimeError("ffmpeg missing; cannot cut clip for direct download")
    s, e = normalize_clip_bounds(start_sec, end_sec)
    if s is None and e is None:
        return src
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    # -ss after -i is more accurate; for long files input -ss is faster — prefer accurate cut
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if s is not None and s > 0:
        cmd += ["-ss", str(s)]
    cmd += ["-i", str(src)]
    if e is not None and e > 0:
        # duration when we have start; absolute end when start is 0
        if s is not None and s > 0:
            dur = max(0.1, float(e) - float(s))
            cmd += ["-t", str(dur)]
        else:
            cmd += ["-to", str(e)]
    cmd += ["-c", "copy", "-avoid_negative_ts", "make_zero", str(dest)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800, check=False)
    if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size < 32:
        # re-encode fallback (copy can fail on keyframes)
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        cmd2 = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        if s is not None and s > 0:
            cmd2 += ["-ss", str(s)]
        cmd2 += ["-i", str(src)]
        if e is not None and e > 0:
            if s is not None and s > 0:
                cmd2 += ["-t", str(max(0.1, float(e) - float(s)))]
            else:
                cmd2 += ["-to", str(e)]
        cmd2 += [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            str(dest),
        ]
        proc2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=3600, check=False)
        if proc2.returncode != 0 or not dest.is_file() or dest.stat().st_size < 32:
            err = (proc2.stderr or proc.stderr or "")[-400:]
            raise RuntimeError(f"ffmpeg cut failed: {err}")
    return dest


async def _run_direct(
    job_id: int,
    url: str,
    headers: dict[str, str],
    cat: str,
    title: str,
    media_type: str,
    uh: str,
    source_page: str,
    start_sec: float | None = None,
    end_sec: float | None = None,
    allow_ios_incompatible: bool = False,
) -> None:
    settings = get_settings()
    if bool(getattr(settings, "block_live_streams", True)):
        live_why = live_stream_reject_reason(url)
        if live_why:
            _finish_fail(
                job_id,
                "failed_network",
                0,
                f"blocked live/unbounded stream: {live_why}",
                False,
            )
            return

    timeout = httpx.Timeout(settings.request_timeout_sec, connect=30.0)
    work = settings.tmp_path() / "jobs" / str(job_id)
    work.mkdir(parents=True, exist_ok=True)
    tmp_path = work / "download.bin"
    max_file = int(settings.max_file_bytes or 0)
    unknown_cap = settings.effective_max_unknown_size_bytes()

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

        # No Content-Length: treat as high-risk unbounded (live) unless already capped
        stream_cap = max_file if max_file > 0 else 0
        if size <= 0:
            stream_cap = unknown_cap if (not stream_cap or unknown_cap < stream_cap) else stream_cap
            # Prefer reject known FLV live content-types early after first probe fails length
            if bool(getattr(settings, "block_live_streams", True)):
                live_why2 = live_stream_reject_reason(url, ct)
                if live_why2:
                    _finish_fail(
                        job_id,
                        "failed_network",
                        0,
                        f"blocked live/unbounded stream: {live_why2}",
                        False,
                    )
                    return

        try:
            if used_gopeed:
                pass  # already have tmp_path
            elif (
                connections > 1
                and size >= _RANGE_MIN_BYTES
                and accept_ranges
                and (not max_file or size <= max_file)
            ):
                await _download_multi_range(client, url, hdrs, tmp_path, size, connections)
                used_multi = True
                status = 200
                if tmp_path.is_file():
                    with tmp_path.open("rb") as f:
                        first = f.read(200)
            else:
                status, ct2, first = await _stream_to_file(
                    client,
                    url,
                    hdrs,
                    tmp_path,
                    max_bytes=stream_cap,
                    known_size=size,
                    job_id=job_id,
                )
                ct = ct or ct2
                if status in (401, 403) and source_page:
                    hdrs2 = dict(headers)
                    hdrs2["Referer"] = source_page
                    status, ct, first = await _stream_to_file(
                        client,
                        url,
                        hdrs2,
                        tmp_path,
                        max_bytes=stream_cap,
                        known_size=size,
                        job_id=job_id,
                    )
        except httpx.HTTPError as e:
            msg = str(e)
            if "size cap" in msg or "unbounded" in msg:
                _finish_fail(job_id, "failed_disk", 0, msg[:500], False)
                return
            # multi-range fail → single stream fallback
            if used_multi or connections > 1:
                logger.info("job %s multi-range failed (%s), fallback single", job_id, e)
                try:
                    status, ct, first = await _stream_to_file(
                        client,
                        url,
                        hdrs,
                        tmp_path,
                        max_bytes=stream_cap,
                        known_size=size,
                        job_id=job_id,
                    )
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
        if max_file and fsize > max_file:
            tmp_path.unlink(missing_ok=True)
            _finish_fail(job_id, "failed_disk", 0, "File exceeds max_file_bytes", False)
            return
        # No declared size and hit near unknown_cap → almost certainly live/unbounded
        if size <= 0 and fsize >= unknown_cap:
            tmp_path.unlink(missing_ok=True)
            _finish_fail(
                job_id,
                "failed_disk",
                0,
                f"no Content-Length and size hit cap {unknown_cap}; blocked as unbounded stream",
                False,
            )
            return

        mtype = detect_media_type(url, ct, media_type)
        ext = guess_ext(url, ct, mtype)
        clip_key = clip_disambiguator(start_sec, end_sec)
        fname = safe_filename(title, url, ext, disambiguator=clip_key)
        dest_dir = settings.medias_path()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = ensure_unique_path(dest_dir / fname)

        # Optional time-range clip (same URL + different ranges must become different files)
        s_clip, e_clip = normalize_clip_bounds(start_sec, end_sec)
        if s_clip is not None or e_clip is not None:
            cut_tmp = work / "clip.mp4"
            try:
                _ffmpeg_cut_file(tmp_path, cut_tmp, start_sec=s_clip, end_sec=e_clip)
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                # prefer .mp4 after cut
                if dest.suffix.lower() != ".mp4":
                    dest = ensure_unique_path(dest.with_suffix(".mp4"))
                shutil.move(str(cut_tmp), str(dest))
                mtype = "video"
                if used_gopeed:
                    warn = "gopeed;clip"
                elif used_multi:
                    warn = "multi-range;clip"
                else:
                    warn = "clip"
            except Exception as e:
                logger.warning("job %s clip failed (%s); keep full file", job_id, e)
                shutil.move(str(tmp_path), str(dest))
                if used_gopeed:
                    warn = f"gopeed;clip_fail:{e}"
                elif used_multi:
                    warn = f"multi-range;clip_fail:{e}"
                else:
                    warn = f"clip_fail:{e}"
        else:
            shutil.move(str(tmp_path), str(dest))
            if used_gopeed:
                warn = "gopeed"
            elif used_multi:
                warn = "multi-range"
            else:
                warn = ""

        # Content probe after download (audio may use .mp4 suffix)
        try:
            from app.services.media_process import classify_media_file

            cls = classify_media_file(dest, hinted=mtype, content_type=ct)
            if cls.get("media_type") in ("audio", "video", "image", "gif"):
                mtype = cls["media_type"]
            if cls.get("mime"):
                ct = cls["mime"] or ct
        except Exception as e:
            logger.warning("classify after download failed: %s", e)

        display_title = title or dest.stem
        if clip_key and title:
            display_title = f"{title} [{clip_key}]"
        await _register_media(
            job_id,
            cat=cat,
            title=display_title,
            media_type=mtype,
            dest=dest,
            source_url=url,
            uh=uh,
            mime=ct or "",
            partial=False,
            warning=warn,
            allow_ios_incompatible=allow_ios_incompatible,
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
    allow_ios_incompatible: bool = False,
) -> None:
    # Misrouted DASH (old client labeled .mpd as m3u8)
    if url.lower().split("?")[0].endswith(".mpd") or (
        "dash" in url.lower() and ".mpd" in url.lower()
    ):
        await _run_dash(
            job_id,
            url,
            headers,
            cat,
            title,
            uh,
            source_page,
            allow_ios_incompatible=allow_ios_incompatible,
        )
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
            allow_ios_incompatible=allow_ios_incompatible,
        )
    except HlsError as e:
        err = str(e)
        if getattr(e, "codec_reject", False):
            _finish_fail(job_id, "failed_codec", 0, err[:1000], False)
            return
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
    av_tl = meta.get("av_timeline") or {}
    if av_tl:
        logger.info(
            "m3u8 av-timeline job=%s action=%s ok=%s note=%s",
            job_id,
            av_tl.get("action"),
            av_tl.get("ok"),
            (av_tl.get("note") or "")[:240],
        )
    # Same m3u8 URL + different clips must not share one dest / rel_path
    clip_key = clip_disambiguator(start_sec, end_sec)
    fname = safe_filename(
        title, url, out_file.suffix.lstrip(".") or "mp4", disambiguator=clip_key
    )
    dest = settings.medias_path() / fname
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest = ensure_unique_path(dest)
    # Always snapshot A/V probe next to media (post-mortem even when probe looks clean)
    work_json = work / "av_timeline.json"
    shutil.move(str(out_file), str(dest))
    try:
        import json as _json

        side = dest.with_name(dest.name + ".av_timeline.json")
        if work_json.is_file():
            shutil.copy2(str(work_json), str(side))
        elif av_tl:
            side.write_text(
                _json.dumps(av_tl, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    except Exception as e:
        logger.debug("copy av_timeline.json skip: %s", e)
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
        allow_ios_incompatible=allow_ios_incompatible,
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
    allow_ios_incompatible: bool = False,
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
        meta = await download_dash(
            url,
            headers,
            work,
            out,
            progress_cb=progress_cb,
            allow_ios_incompatible=allow_ios_incompatible,
        )
    except DashError as e:
        if getattr(e, "codec_reject", False):
            _finish_fail(job_id, "failed_codec", 0, str(e)[:1000], False)
            return
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
        allow_ios_incompatible=allow_ios_incompatible,
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
    allow_ios_incompatible: bool = False,
) -> None:
    settings = get_settings()
    # Flat layout: rel_path is filename only (legacy rows may still be cat/name)
    rel = dest.name
    try:
        rel = dest.resolve().relative_to(settings.medias_path().resolve()).as_posix()
    except Exception:
        rel = dest.name
    # Content-based type (audio tracks often ship as .mp4)
    try:
        from app.services.media_process import classify_media_file

        cls = classify_media_file(dest, hinted=media_type, content_type=mime)
        if cls.get("media_type") in ("audio", "video", "image", "gif"):
            media_type = cls["media_type"]
        if cls.get("mime"):
            mime = cls["mime"] or mime
    except Exception as e:
        logger.warning("classify in _register_media: %s", e)
    if media_type == "m3u8":
        media_type = "video"

    from app.services.media_process import assert_ios_playable

    if not allow_ios_incompatible:
        try:
            assert_ios_playable(dest, media_type)
        except IosCodecError:
            try:
                dest.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    chash, fsize = hash_media_file(dest)
    if not fsize and dest.is_file():
        try:
            fsize = int(dest.stat().st_size)
        except OSError:
            fsize = 0

    content_dup = False
    with session_scope() as db:
        job = db.get(DownloadJob, job_id)
        tags_json = (job.tags_json if job and getattr(job, "tags_json", None) else None) or "[]"
        want_jasna = bool(job and getattr(job, "use_jasna", False))

        # Content gate: same file bytes already in library → reuse row, drop new file
        existing = None
        if chash:
            existing = find_item_by_content(
                db, chash, fsize, exclude_rel=rel
            )
        if existing:
            from app.services.tags import normalize_tags, tags_from_json, tags_to_json

            content_dup = True
            media_id = int(existing.id)
            if not (getattr(existing, "content_hash", None) or "").strip():
                existing.content_hash = chash
            if tags_json and tags_json != "[]":
                merged = normalize_tags(
                    tags_from_json(existing.tags_json) + tags_from_json(tags_json)
                )
                existing.tags_json = tags_to_json(merged)
            warn = (warning or "").strip()
            note = "content_duplicate"
            existing.warning = (
                f"{existing.warning};{note}".strip(";") if existing.warning else note
            )
            if job:
                job.status = "success"
                job.media_id = media_id
                job.progress = 100
                job.error_message = (warn + f" [{note}]").strip() if warn else note
                job.headers_json = "{}"
            db.commit()
            if job:
                logger.info(
                    "job %s success media_id=%s content_dup=1 size=%s",
                    job_id,
                    media_id,
                    fsize,
                )
        else:
            item = MediaItem(
                category="default",
                title=title[:512],
                media_type=media_type,
                rel_path=rel,
                source_url=source_url[:2048],
                url_hash=uh,
                content_hash=chash or "",
                file_size=fsize,
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
            if job:
                logger.info(
                    "job %s success media_id=%s content_dup=0 size=%s type=%s",
                    job_id,
                    media_id,
                    fsize,
                    media_type,
                )

    if content_dup:
        # Drop the just-downloaded copy; library already has identical bytes
        try:
            if dest.is_file():
                dest.unlink(missing_ok=True)
        except OSError:
            logger.warning("unlink content-dup download failed: %s", dest)
        # Do not re-thumb or re-queue jasna for an existing item
        return

    thumb_rel = await asyncio.to_thread(
        generate_thumb, dest, media_id, media_type if media_type != "m3u8" else "video"
    )
    if thumb_rel:
        with session_scope() as db:
            item = db.get(MediaItem, media_id)
            if item:
                item.thumb_rel = thumb_rel
                db.commit()

    if want_jasna:
        try:
            from app.core.config import get_settings as _gs
            from app.services.jasna import enqueue_jasna_for_media

            if bool(getattr(_gs(), "jasna_enabled", False)):
                enqueue_jasna_for_media(media_id)
        except Exception:
            logger.exception("jasna enqueue after download failed media=%s", media_id)


def _finish_fail(
    job_id: int,
    status: str,
    http_status: int,
    message: str,
    client_fallback: bool,
) -> None:
    logger.warning(
        "job %s end status=%s http=%s fallback=%s err=%s",
        job_id,
        status,
        http_status,
        client_fallback,
        (message or "")[:300],
    )
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
    # Always drop staging files so failed live/partial downloads cannot fill the disk
    try:
        work = get_settings().tmp_path() / "jobs" / str(job_id)
        if work.is_dir():
            shutil.rmtree(work, ignore_errors=True)
    except Exception:
        logger.debug("cleanup job work dir failed job=%s", job_id, exc_info=True)


class RegisterResult:
    """Result of registering a file under Medias/."""

    __slots__ = ("item", "duplicate", "content_hash")

    def __init__(self, item: MediaItem, *, duplicate: bool = False, content_hash: str = ""):
        self.item = item
        self.duplicate = duplicate
        self.content_hash = content_hash or ""


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
) -> RegisterResult:
    """
    Register a file already written under Medias/.

    Always enforces **content** dedupe: if SHA-256 matches an existing library
    file, the new ``dest`` is discarded and the existing row is returned with
    ``duplicate=True`` (tags merged). URL-based ``dedupe`` remains optional for
    same-path / legacy source_url collapse (extension capture uses False so
    different captures on the same page URL stay distinct **unless** bytes match).

    media_type is re-checked via content (ffprobe / magic); extension is not trusted
    (e.g. pure audio packaged as .mp4 → stored as audio).
    """
    from app.services.media_process import classify_media_file
    from app.services.tags import normalize_tags, tags_from_json, tags_to_json

    settings = get_settings()
    try:
        rel = dest.resolve().relative_to(settings.medias_path().resolve()).as_posix()
    except Exception:
        rel = dest.name
    size = dest.stat().st_size if dest.is_file() else 0
    # Content-based type: never trust suffix alone
    cls = classify_media_file(dest, hinted=media_type, content_type=mime)
    media_type = cls.get("media_type") or media_type or "video"
    if media_type == "m3u8":
        media_type = "video"
    mime = (cls.get("mime") or mime or "").strip()
    from app.services.media_process import IosCodecError, assert_ios_playable

    try:
        assert_ios_playable(dest, media_type)
    except IosCodecError:
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    chash, hsize = hash_media_file(dest)
    if hsize:
        size = hsize
    # Unique per file path + size so re-uploads never clobber DB identity by URL alone
    uh = url_hash(f"upload|{rel}|{size}|{source_url or ''}", "default")
    tag_json = tags_to_json(tags or [])
    content_dup = False
    with session_scope() as db:
        existing = None
        # 1) Byte-identical library hit (any path / any source_url)
        if chash:
            existing = find_item_by_content(db, chash, size, exclude_rel=rel)
            if existing:
                content_dup = True
        # 2) Optional URL-style dedupe (legacy)
        if not existing and dedupe and source_url:
            existing = db.scalars(
                select(MediaItem).where(MediaItem.url_hash == uh)
            ).first()
        # 3) Same rel_path (overwrite / re-register same dest)
        if not existing:
            existing = db.scalars(select(MediaItem).where(MediaItem.rel_path == rel)).first()

        if existing and content_dup:
            if not (getattr(existing, "content_hash", None) or "").strip():
                existing.content_hash = chash
            if tags:
                merged = normalize_tags(tags_from_json(existing.tags_json) + list(tags))
                existing.tags_json = tags_to_json(merged)
            db.commit()
            db.refresh(existing)
            media_id = existing.id
            mtype = existing.media_type or media_type
            dest_for_thumb = None  # keep existing thumb
        elif existing:
            existing.file_size = size
            existing.mime = mime or existing.mime
            existing.media_type = media_type or existing.media_type
            existing.title = (title or existing.title or dest.stem)[:512]
            if chash:
                existing.content_hash = chash
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
                content_hash=chash or "",
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
            content_dup = False

    if content_dup:
        # Drop the new copy when it is not the kept library path
        try:
            kept_rel = ""
            with session_scope() as db:
                kept = db.get(MediaItem, media_id)
                kept_rel = (kept.rel_path if kept else "") or ""
            if dest.is_file() and kept_rel and rel != kept_rel:
                dest.unlink(missing_ok=True)
        except OSError:
            logger.warning("unlink content-dup upload failed: %s", dest)
        with session_scope() as db:
            item = db.get(MediaItem, media_id)
            return RegisterResult(item, duplicate=True, content_hash=chash)

    if dest_for_thumb is not None:
        thumb_rel = generate_thumb(dest_for_thumb, media_id, mtype)
        if thumb_rel:
            with session_scope() as db:
                item = db.get(MediaItem, media_id)
                if item:
                    item.thumb_rel = thumb_rel
                    db.commit()
                    db.refresh(item)
                    return RegisterResult(item, duplicate=False, content_hash=chash)
    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        return RegisterResult(item, duplicate=False, content_hash=chash)
