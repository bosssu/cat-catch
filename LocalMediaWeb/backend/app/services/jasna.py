"""Jasna demosaic: fully isolated child process so LMW API never freezes.

Design (Windows):
- Spawn jasna.exe in its **own console window** (CREATE_NEW_CONSOLE),
  default **minimized** (STARTUPINFO + EnumWindows fallback).
- **No stdout/stderr pipes** back to the server (pipe back-pressure / asyncio
  Proactor bugs were hanging /api/media and health).
- Server only polls process exit + output file size every ~2s with asyncio.sleep
  (event loop always free).
- Optional log file for post-mortem; progress UI is soft estimate + console bar.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import JasnaJob, MediaItem

logger = logging.getLogger("lmw.jasna")

_worker_task: asyncio.Task | None = None
_running: bool = False
_cancel_flags: set[int] = set()
_active_popen: subprocess.Popen | None = None
_active_job_id: int | None = None

# CREATE_NEW_CONSOLE = 0x10 — own window; not DETACHED (progress in console)
_CREATE_NEW_CONSOLE = 0x00000010
_CREATE_NEW_PROCESS_GROUP = 0x00000200
# STARTF_USESHOWWINDOW + SW_SHOWMINNOACTIVE → 新控制台默认最小化，不抢焦点
_STARTF_USESHOWWINDOW = 0x00000001
_SW_SHOWMINNOACTIVE = 7
_SW_SHOWMINIMIZED = 2

_PCT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*%")
_FRAC_RE = re.compile(r"(\d{1,9})\s*/\s*(\d{1,9})")


def resolve_jasna_path(explicit: str = "") -> str | None:
    """Return absolute path to jasna.exe / jasna, or None."""
    candidates: list[Path] = []
    if explicit:
        p = Path(explicit)
        if p.is_dir():
            candidates.extend([p / "jasna.exe", p / "jasna"])
        else:
            candidates.append(p)

    which = shutil.which("jasna") or shutil.which("jasna.exe")
    if which:
        candidates.append(Path(which))

    home = Path.home()
    candidates.extend(
        [
            Path(r"D:\TMP\jasna-windows-nvidia-0.8.1\jasna.exe"),
            home / "jasna" / "jasna.exe",
            Path(r"C:\jasna\jasna.exe"),
        ]
    )

    for c in candidates:
        try:
            if c.is_file():
                return str(c.resolve())
        except OSError:
            continue
    return None


def jasna_available() -> bool:
    s = get_settings()
    if not bool(getattr(s, "jasna_enabled", True)):
        return False
    return resolve_jasna_path(getattr(s, "jasna_path", "") or "") is not None


def request_cancel(job_id: int) -> None:
    _cancel_flags.add(job_id)
    global _active_popen, _active_job_id
    if _active_job_id == job_id and _active_popen is not None:
        _kill_popen(_active_popen)


def _kill_popen(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is not None:
            return
        if sys.platform == "win32":
            # Kill process tree if possible
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
                return
            except Exception:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    except Exception as e:
        logger.warning("jasna kill failed: %s", e)


def enqueue_jasna_for_media(media_id: int, *, force: bool = False) -> int | None:
    """Queue demosaic for a media item. Returns job id or None if skipped."""
    s = get_settings()
    if not force and not bool(getattr(s, "jasna_enabled", True)):
        logger.info("jasna enqueue skip media=%s: disabled", media_id)
        return None
    exe = resolve_jasna_path(getattr(s, "jasna_path", "") or "")
    if not exe:
        logger.warning("jasna enqueue skip media=%s: binary not found", media_id)
        return None

    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            return None
        mtype = (item.media_type or "").lower()
        if mtype not in ("video", "m3u8"):
            logger.info("jasna enqueue skip media=%s: not video (%s)", media_id, mtype)
            return None

        active = db.scalars(
            select(JasnaJob).where(
                JasnaJob.media_id == media_id,
                JasnaJob.status.in_(("queued", "running")),
            )
        ).first()
        if active and not force:
            return active.id

        medias = s.medias_path()
        src = medias / item.rel_path
        if not src.is_file():
            alt = medias / (item.category or "default") / Path(item.rel_path).name
            if alt.is_file():
                src = alt
            else:
                logger.warning(
                    "jasna enqueue skip media=%s: file missing %s", media_id, item.rel_path
                )
                return None

        job = JasnaJob(
            media_id=media_id,
            status="queued",
            progress=0.0,
            input_path=str(src.resolve()),
            output_path="",
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        jid = job.id
        logger.info("jasna enqueued job=%s media=%s path=%s", jid, media_id, src)
        return jid


async def start_jasna_worker() -> None:
    global _worker_task
    with session_scope() as db:
        rows = db.scalars(select(JasnaJob).where(JasnaJob.status == "running")).all()
        for j in rows:
            j.status = "queued"
            j.error_message = ((j.error_message or "") + " Resumed after restart").strip()
            j.progress = 0.0
        db.commit()
    if _worker_task is None or _worker_task.done():
        _worker_task = asyncio.create_task(_loop(), name="lmw-jasna-worker")
        logger.info("jasna worker started (isolated console mode)")


async def _loop() -> None:
    global _running
    while True:
        try:
            if not _running:
                await _pump_one()
        except Exception:
            logger.exception("jasna worker loop error")
        await asyncio.sleep(0.5)


async def _pump_one() -> None:
    global _running
    with session_scope() as db:
        job = db.scalars(
            select(JasnaJob)
            .where(JasnaJob.status == "queued")
            .order_by(JasnaJob.id.asc())
            .limit(1)
        ).first()
        if not job:
            return
        job_id = job.id
        job.status = "running"
        job.progress = 0.0
        job.error_message = ""
        db.commit()
    _running = True
    try:
        await _run_job(job_id)
    finally:
        _running = False


def _set_job_progress(job_id: int, progress: float) -> None:
    try:
        with session_scope() as db:
            j = db.get(JasnaJob, job_id)
            if j and j.status == "running":
                j.progress = float(min(99.0, max(0.0, progress)))
                db.commit()
    except Exception as e:
        logger.debug("jasna progress write skip: %s", e)


def _estimate_progress_from_output(
    out_path: Path,
    input_path: Path,
    current: float,
    started_at: float,
) -> float:
    """Soft progress from output growth + elapsed time (no CLI pipe needed)."""
    best = current
    try:
        if out_path.is_file():
            out_sz = out_path.stat().st_size
            if out_sz >= 32 * 1024:
                in_sz = input_path.stat().st_size if input_path.is_file() else 0
                if in_sz > 0:
                    ratio = out_sz / float(in_sz)
                    soft = min(92.0, max(2.0, ratio * 80.0))
                    best = max(best, soft)
                else:
                    best = max(best, min(40.0, 3.0 + out_sz / (8 * 1024 * 1024) * 10.0))
    except OSError:
        pass
    # Time-based crawl so UI isn't stuck at 0 during model load (console still shows real bar)
    elapsed = time.monotonic() - started_at
    if elapsed > 15 and best < 5:
        best = max(best, min(8.0, 1.0 + elapsed / 120.0))
    return min(99.0, best)


def _tail_text(path: Path, max_bytes: int = 8000) -> str:
    try:
        if not path.is_file():
            return ""
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            raw = f.read()
        return raw.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _parse_progress_text(text: str, current: float) -> float:
    if not text:
        return current
    best = current
    for m in _PCT_RE.finditer(text.replace("\r", "\n")):
        try:
            v = float(m.group(1))
            if 0 <= v <= 100:
                best = max(best, v)
        except ValueError:
            pass
    for m in _FRAC_RE.finditer(text):
        try:
            done, total = int(m.group(1)), int(m.group(2))
            if total >= 10 and 0 <= done <= total:
                best = max(best, min(99.0, 100.0 * done / total))
        except ValueError:
            pass
    return min(99.0, best)


def _minimize_window_for_pid(pid: int) -> None:
    """Best-effort: minimize top-level windows owned by *pid* (Windows only)."""
    if sys.platform != "win32" or not pid:
        return
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        EnumWindows = user32.EnumWindows
        GetWindowThreadProcessId = user32.GetWindowThreadProcessId
        IsWindowVisible = user32.IsWindowVisible
        ShowWindow = user32.ShowWindow
        GetWindow = user32.GetWindow
        GW_OWNER = 4

        found: list[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _enum(hwnd, _lparam):  # type: ignore[no-untyped-def]
            proc_id = wintypes.DWORD()
            GetWindowThreadProcessId(hwnd, ctypes.byref(proc_id))
            if int(proc_id.value) != int(pid):
                return True
            # Prefer visible top-level (console) windows without owner
            if not IsWindowVisible(hwnd):
                return True
            if GetWindow(hwnd, GW_OWNER):
                return True
            ShowWindow(hwnd, _SW_SHOWMINNOACTIVE)
            found.append(int(hwnd))
            return True

        EnumWindows(_enum, 0)
        if not found:
            # Console host may attach slightly later; one more pass is enough via caller retry
            pass
    except Exception as e:
        logger.debug("jasna minimize window skip: %s", e)


def _spawn_jasna_console(
    cmd: list[str],
    cwd: str,
    log_path: Path,
    job_id: int = 0,
) -> subprocess.Popen:
    """
    Start jasna in a **new console window**, completely decoupled from uvicorn.

    Critical: do **not** use stdout=PIPE (that hung the whole LocalMediaWeb
    server). Progress is visible in the new console; we only poll exit code
    and output file size.
    """
    try:
        log_path.write_text(
            "cmd: " + subprocess.list2cmdline(cmd) + "\n"
            f"cwd: {cwd}\n"
            "mode: CREATE_NEW_CONSOLE + minimized (no pipes)\n",
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        pass

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")

    if sys.platform == "win32":
        # Prefer API flag (Python 3.7+ on Windows)
        flags = getattr(subprocess, "CREATE_NEW_CONSOLE", _CREATE_NEW_CONSOLE)
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", _CREATE_NEW_PROCESS_GROUP)
        # Do not pass stdout/stderr → attached to the new console.
        # stdin DEVNULL avoids the console waiting for input.
        # 控制台默认最小化：需要时用户可从任务栏点开看 tqdm
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(
            subprocess, "STARTF_USESHOWWINDOW", _STARTF_USESHOWWINDOW
        )
        startupinfo.wShowWindow = _SW_SHOWMINNOACTIVE
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
            startupinfo=startupinfo,
            close_fds=False,
        )
        # 兜底：控制台 HWND 有时略晚才出现，短延迟再最小化一次
        def _retry_min() -> None:
            import time as _t

            for _ in range(5):
                _t.sleep(0.15)
                try:
                    if proc.poll() is not None:
                        return
                    _minimize_window_for_pid(proc.pid)
                except Exception:
                    pass

        try:
            import threading

            threading.Thread(target=_retry_min, name="jasna-min-console", daemon=True).start()
        except Exception:
            try:
                _minimize_window_for_pid(proc.pid)
            except Exception:
                pass
        return proc

    log_f = open(log_path, "ab", buffering=0)  # noqa: SIM115
    return subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_f,
        stderr=subprocess.STDOUT,
    )


async def _run_job(job_id: int) -> None:
    global _active_popen, _active_job_id
    settings = get_settings()
    exe = resolve_jasna_path(getattr(settings, "jasna_path", "") or "")
    if not exe:
        _finish(job_id, "failed", 0, "jasna binary not found")
        return

    with session_scope() as db:
        job = db.get(JasnaJob, job_id)
        if not job:
            return
        media_id = job.media_id
        item = db.get(MediaItem, media_id)
        if not item:
            job.status = "failed"
            job.error_message = "media missing"
            db.commit()
            return
        rel = item.rel_path
        medias = settings.medias_path()
        src = Path(job.input_path) if job.input_path else medias / rel
        if not src.is_file():
            src = medias / rel
        if not src.is_file():
            job.status = "failed"
            job.error_message = f"input missing: {rel}"
            db.commit()
            return
        input_path = str(src.resolve())
        job.input_path = input_path
        db.commit()

    if job_id in _cancel_flags:
        _cancel_flags.discard(job_id)
        _finish(job_id, "cancelled", 0, "Cancelled")
        return

    work = settings.tmp_path() / "jasna" / str(job_id)
    work.mkdir(parents=True, exist_ok=True)
    out_tmp = work / "out.mp4"
    log_path = work / "jasna.log"
    if out_tmp.exists():
        try:
            out_tmp.unlink()
        except OSError:
            pass

    cwd = (getattr(settings, "jasna_cwd", "") or "").strip()
    if not cwd:
        cwd = str(Path(exe).resolve().parent)
    codec = (getattr(settings, "jasna_codec", None) or "h264").strip() or "h264"
    extra = list(getattr(settings, "jasna_extra_args", None) or [])

    # Note: do not pass --fmp4 — jasna 0.8.1 rejects it (unrecognized).
    cmd = [
        exe,
        "--input",
        input_path,
        "--output",
        str(out_tmp.resolve()),
        "--codec",
        codec,
        "--log-level",
        "info",
    ]
    for a in extra:
        s = str(a).strip()
        if not s:
            continue
        # skip flags this package build may not have
        if s in ("--fmp4",):
            continue
        cmd.append(s)

    logger.info("jasna start job=%s (new console) cmd=%s", job_id, cmd)
    with session_scope() as db:
        j = db.get(JasnaJob, job_id)
        if j:
            j.output_path = str(out_tmp)
            j.error_message = "running in separate console window"
            db.commit()

    try:
        proc = _spawn_jasna_console(cmd, cwd, log_path, job_id=job_id)
    except Exception as e:
        logger.exception("jasna spawn failed job=%s", job_id)
        _finish(job_id, "failed", 0, f"spawn failed: {e}")
        return

    _active_popen = proc
    _active_job_id = job_id
    progress = 0.0
    last_written = -1.0
    started = time.monotonic()
    in_path = Path(input_path)

    try:
        # Pure async wait: never block event loop, never hold thread-pool workers
        while True:
            if job_id in _cancel_flags:
                logger.info("jasna cancel job=%s pid=%s", job_id, proc.pid)
                _kill_popen(proc)
                break

            rc = proc.poll()
            soft = _estimate_progress_from_output(out_tmp, in_path, progress, started)
            # Optional: if a log file was written by something else, scrape it
            soft = _parse_progress_text(_tail_text(log_path), soft)
            if soft > progress:
                progress = soft
            if progress - last_written >= 1.0 or (progress > 0 and last_written < 0):
                _set_job_progress(job_id, progress)
                last_written = progress

            if rc is not None:
                break

            await asyncio.sleep(2.0)

        # Reap
        try:
            if proc.poll() is None:
                proc.wait(timeout=5)
        except Exception:
            _kill_popen(proc)
        rc = proc.returncode if proc.returncode is not None else 1
    except Exception as e:
        logger.exception("jasna job=%s wait error", job_id)
        _kill_popen(proc)
        _finish(job_id, "failed", progress, str(e)[:1000])
        return
    finally:
        _active_popen = None
        _active_job_id = None

    if job_id in _cancel_flags:
        _cancel_flags.discard(job_id)
        try:
            out_tmp.unlink(missing_ok=True)
        except OSError:
            pass
        _finish(job_id, "cancelled", progress, "Cancelled")
        return

    if rc != 0 or not out_tmp.is_file() or out_tmp.stat().st_size < 32:
        tail = _tail_text(log_path, 2000)
        msg = f"jasna exit {rc} (see console window for details)"
        if tail.strip():
            msg = f"{msg}: {tail[-500:]}"
        try:
            out_tmp.unlink(missing_ok=True)
        except OSError:
            pass
        _finish(job_id, "failed", progress, msg[:2000])
        return

    try:
        # File replace can be large — offload copy only
        await asyncio.to_thread(_apply_result, job_id, media_id, Path(input_path), out_tmp)
        _finish(job_id, "success", 100.0, "")
    except Exception as e:
        logger.exception("jasna apply failed job=%s", job_id)
        _finish(job_id, "failed", progress, f"apply failed: {e}"[:2000])


def _apply_result(job_id: int, media_id: int, input_path: Path, out_tmp: Path) -> None:
    """Replace media file with demosaiced mp4 and refresh DB + thumb."""
    from app.services.tags import normalize_tags, tags_from_json, tags_to_json
    from app.services.thumb import generate_thumb

    settings = get_settings()
    medias = settings.medias_path()
    new_rel = ""
    final_path: Path | None = None
    with session_scope() as db:
        item = db.get(MediaItem, media_id)
        if not item:
            raise FileNotFoundError("media row gone")
        old_rel = item.rel_path
        old_path = medias / old_rel
        if not old_path.is_file() and input_path.is_file():
            old_path = input_path

        stem = Path(old_rel).stem
        parent = Path(old_rel).parent
        if str(parent) == ".":
            new_rel = f"{stem}.mp4"
        else:
            new_rel = f"{parent.as_posix()}/{stem}.mp4"
        final_path = medias / new_rel

        if final_path.resolve() != old_path.resolve() and final_path.exists():
            new_rel = f"{Path(old_rel).stem}_jasna_{media_id}.mp4"
            final_path = medias / new_rel

        final_path.parent.mkdir(parents=True, exist_ok=True)
        stage = final_path.with_name(final_path.name + ".partial")
        try:
            if stage.exists():
                stage.unlink()
            shutil.copy2(out_tmp, stage)
            os.replace(stage, final_path)
        except Exception:
            if stage.exists():
                try:
                    stage.unlink()
                except OSError:
                    pass
            raise

        try:
            if old_path.is_file() and old_path.resolve() != final_path.resolve():
                old_path.unlink(missing_ok=True)
        except OSError as e:
            logger.warning("jasna could not remove old file %s: %s", old_path, e)

        try:
            out_tmp.unlink(missing_ok=True)
        except OSError:
            pass

        item.rel_path = new_rel
        item.file_size = final_path.stat().st_size if final_path.is_file() else 0
        item.mime = "video/mp4"
        item.media_type = "video"
        # Force updated_at so API file_url/thumb_url ?v= busts client blob cache
        from datetime import datetime, timezone

        item.updated_at = datetime.now(timezone.utc)
        warn = (item.warning or "").strip()
        note = "jasna_ok"
        item.warning = (
            f"{warn};{note}".strip(";") if warn and note not in warn else (warn or note)
        )
        tags = tags_from_json(item.tags_json)
        if "jasna" not in tags:
            item.tags_json = tags_to_json(normalize_tags(tags + ["jasna"]))
        db.commit()

    assert final_path is not None
    thumb_rel = generate_thumb(final_path, media_id, "video")
    if thumb_rel:
        with session_scope() as db:
            item = db.get(MediaItem, media_id)
            if item:
                item.thumb_rel = thumb_rel
                db.commit()

    logger.info("jasna applied job=%s media=%s -> %s", job_id, media_id, new_rel)


def _finish(job_id: int, status: str, progress: float, message: str) -> None:
    with session_scope() as db:
        j = db.get(JasnaJob, job_id)
        if not j:
            return
        j.status = status
        j.progress = float(progress if status != "success" else 100.0)
        j.error_message = (message or "")[:2000]
        db.commit()
    logger.info("jasna job=%s status=%s progress=%s", job_id, status, progress)
