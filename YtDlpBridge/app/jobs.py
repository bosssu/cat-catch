from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from app import format as fmt
from app import lmw as lmw_api

_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)%")


class JobCancelled(Exception):
    pass


def _kill_proc(proc: subprocess.Popen[str] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except OSError:
        return
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass


def parse_progress_line(line: str) -> float | None:
    m = _PCT_RE.search(line or "")
    if not m:
        return None
    try:
        return max(0.0, min(100.0, float(m.group(1))))
    except ValueError:
        return None


class JobStore:
    def __init__(self, cfg: dict[str, Any], download_dir: Path, *, start_worker: bool = True):
        self.cfg = cfg
        self.download_dir = download_dir
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._queue: list[str] = []
        self._active: str | None = None
        self._cv = threading.Condition(self._lock)
        self._proc: subprocess.Popen[str] | None = None
        self._worker = threading.Thread(target=self._loop, daemon=True)
        if start_worker:
            self._worker.start()

    def enqueue(self, url: str, *, title: str = "", referer: str = "", cookies: str = "") -> dict[str, Any]:
        url = (url or "").strip()
        if not url or not url.startswith(("http://", "https://")):
            raise ValueError("invalid url")
        with self._lock:
            for j in self._jobs.values():
                if j.get("url") == url and j.get("status") in {"queued", "running", "uploading"}:
                    return self._public(j)
            job_id = uuid.uuid4().hex[:12]
            job = {
                "id": job_id,
                "url": url,
                "title": title or "",
                "referer": referer or "",
                "cookies": (cookies or "")[:1_000_000],
                "status": "queued",
                "percent": 0.0,
                "message": "queued",
                "file": "",
                "lmw_id": None,
                "error": "",
                "cancel": False,
                "created": time.time(),
                "updated": time.time(),
            }
            self._jobs[job_id] = job
            self._queue.append(job_id)
            self._cv.notify()
            return self._public(job)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            j = self._jobs.get(job_id)
            return self._public(j) if j else None

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        proc: subprocess.Popen[str] | None = None
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                return None
            if j.get("status") in {"done", "error", "cancelled"}:
                return self._public(j)
            j["cancel"] = True
            if j.get("status") == "queued":
                try:
                    self._queue.remove(job_id)
                except ValueError:
                    pass
                j["status"] = "cancelled"
                j["message"] = "cancelled"
                j["error"] = "cancelled"
                j["updated"] = time.time()
            elif self._active == job_id:
                proc = self._proc
        _kill_proc(proc)
        return self.get(job_id)

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            items = sorted(self._jobs.values(), key=lambda x: x.get("created") or 0, reverse=True)
            return [self._public(j) for j in items[:50]]

    def _public(self, j: dict[str, Any]) -> dict[str, Any]:
        return {k: j[k] for k in ("id", "url", "title", "status", "percent", "message", "file", "lmw_id", "error") if k in j}

    def _update(self, job_id: str, **kw: Any) -> None:
        with self._lock:
            j = self._jobs.get(job_id)
            if not j:
                return
            j.update(kw)
            j["updated"] = time.time()

    def _loop(self) -> None:
        while True:
            with self._cv:
                while not self._queue:
                    self._cv.wait()
                job_id = self._queue.pop(0)
                self._active = job_id
            try:
                self._run(job_id)
            except JobCancelled:
                self._update(job_id, status="cancelled", error="cancelled", message="cancelled")
            except Exception as e:  # noqa: BLE001
                if self._cancelled(job_id):
                    self._update(job_id, status="cancelled", error="cancelled", message=str(e)[:200])
                else:
                    self._update(job_id, status="error", error=str(e), message=str(e)[:200])
            finally:
                with self._lock:
                    self._active = None
                    self._proc = None

    def _run(self, job_id: str) -> None:
        with self._lock:
            job = dict(self._jobs[job_id])
        self._update(job_id, status="running", message="downloading", percent=0.0)
        out_tmpl = str(self.download_dir / f"{job_id}.%(ext)s")
        cookie_blob = str(job.get("cookies") or "")
        with self._lock:
            j0 = self._jobs.get(job_id)
            if j0:
                j0["cookies"] = ""
        cfg_cookie_file = str(self.cfg.get("cookies_file") or "")
        cfg_cookie_browser = str(self.cfg.get("cookies_from_browser") or "")
        ext_cookie_path: Path | None = None
        try:
            self._update(job_id, message="downloading without cookies")
            code, tail = self._exec_ytdlp(
                job_id,
                job,
                out_tmpl,
                cookies_file="",
                cookies_from_browser="",
            )
            have_retry_cookies = bool(cookie_blob.strip() or cfg_cookie_file or cfg_cookie_browser)
            if code != 0 and have_retry_cookies and not self._cancelled(job_id):
                retry_file = ""
                retry_browser = ""
                if cookie_blob.strip():
                    ext_cookie_path = self.download_dir / f"{job_id}.cookies.txt"
                    ext_cookie_path.write_text(cookie_blob, encoding="utf-8")
                    retry_file = str(ext_cookie_path)
                    self._update(job_id, message="retry with extension cookies", percent=0.0)
                elif cfg_cookie_file:
                    retry_file = cfg_cookie_file
                    self._update(job_id, message="retry with cookies file", percent=0.0)
                else:
                    retry_browser = cfg_cookie_browser
                    self._update(job_id, message="retry with browser cookies", percent=0.0)
                code, tail = self._exec_ytdlp(
                    job_id,
                    job,
                    out_tmpl,
                    cookies_file=retry_file,
                    cookies_from_browser=retry_browser,
                )
            if self._cancelled(job_id):
                raise JobCancelled()
            if code != 0:
                detail = next((x for x in reversed(tail) if x.strip()), f"yt-dlp exit {code}")
                raise RuntimeError(detail[:300])
            produced = self._find_output(job_id)
        finally:
            if ext_cookie_path and ext_cookie_path.is_file():
                try:
                    ext_cookie_path.unlink()
                except OSError:
                    pass
        if not produced:
            raise RuntimeError("download finished but no file")

        final = produced
        if self.cfg.get("ios_lock", True):
            probe = fmt.probe_codecs(produced)
            if not fmt.is_ios_playable(probe):
                self._update(job_id, message="recode to h264+aac mp4", percent=99.0)
                dest = self.download_dir / f"{job_id}.ios.mp4"
                fmt.recode_to_ios(produced, dest)
                final = dest

        if final.suffix.lower() in {".mp4", ".m4v", ".mov"}:
            self._update(job_id, message="faststart", percent=99.2, file=str(final))
            final = fmt.ensure_faststart(final)

        lmw_id = None
        lmw = self.cfg.get("lmw") or {}
        if self._cancelled(job_id):
            raise JobCancelled()

        if lmw.get("upload"):
            self._update(job_id, status="uploading", message="upload LMW", percent=99.5, file=str(final))

            def _on_retry(attempt: int, total: int, wait: float, exc: BaseException) -> None:
                self._update(
                    job_id,
                    message=f"upload retry {attempt}/{total} in {wait:.0f}s: {exc}"[:200],
                    percent=99.5,
                )

            res = lmw_api.upload_with_retry(
                lmw.get("base_url") or "",
                final,
                token=lmw.get("token") or "",
                title=job.get("title") or final.stem,
                source_url=job["url"],
                remux=bool(lmw.get("remux", False)),
                attempts=int(lmw.get("retries") or 3),
                backoff=float(lmw.get("retry_backoff") or 2.0),
                on_retry=_on_retry,
            )
            lmw_id = res.get("id") or (res.get("item") or {}).get("id")
        self._update(
            job_id,
            status="done",
            percent=100.0,
            message="done",
            file=str(final),
            lmw_id=lmw_id,
        )
        if not self.cfg.get("keep_file", True) and final.is_file():
            try:
                final.unlink()
            except OSError:
                pass

    def _exec_ytdlp(
        self,
        job_id: str,
        job: dict[str, Any],
        out_tmpl: str,
        *,
        cookies_file: str,
        cookies_from_browser: str,
    ) -> tuple[int, list[str]]:
        ytdlp = shutil.which("yt-dlp")
        cmd = [
            ytdlp or "yt-dlp",
            *fmt.ytdlp_base_args(
                max_height=int(self.cfg.get("max_height") or 1080),
                cookies_file=cookies_file,
                cookies_from_browser=cookies_from_browser,
                proxy=str(self.cfg.get("proxy") or ""),
            ),
            "-o",
            out_tmpl,
            job["url"],
        ]
        if job.get("referer"):
            cmd.extend(["--referer", job["referer"]])
        if not ytdlp:
            cmd = [self._python(), "-m", "yt_dlp", *cmd[1:]]
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        with self._lock:
            self._proc = proc
        tail = self._watch_download(job_id, proc)
        if self._cancelled(job_id):
            raise JobCancelled()
        code = proc.poll()
        if code is None:
            _kill_proc(proc)
            raise RuntimeError("yt-dlp hung")
        return int(code), tail

    def _cancelled(self, job_id: str) -> bool:
        with self._lock:
            j = self._jobs.get(job_id)
            return bool(j and j.get("cancel"))

    def _watch_download(self, job_id: str, proc: subprocess.Popen[str]) -> list[str]:
        assert proc.stdout
        last_out = time.time()
        started = last_out
        limit = float(self.cfg.get("download_timeout") or 2400)
        stall = float(self.cfg.get("stall_timeout") or 180)
        tail: list[str] = []

        def _reader() -> None:
            nonlocal last_out
            assert proc.stdout
            for line in proc.stdout:
                last_out = time.time()
                text = (line or "").rstrip()
                if text:
                    tail.append(text)
                    if len(tail) > 40:
                        del tail[:-40]
                pct = parse_progress_line(line)
                if pct is not None:
                    self._update(job_id, percent=min(pct, 99.0), message=text[:200])
                elif text:
                    self._update(job_id, message=text[:200])

        t = threading.Thread(target=_reader, daemon=True)
        t.start()
        while t.is_alive():
            if self._cancelled(job_id):
                _kill_proc(proc)
                t.join(timeout=8)
                raise JobCancelled()
            now = time.time()
            if now - started > limit:
                _kill_proc(proc)
                t.join(timeout=8)
                raise RuntimeError(f"yt-dlp timeout {int(limit)}s")
            if now - last_out > stall:
                _kill_proc(proc)
                t.join(timeout=8)
                raise RuntimeError(f"yt-dlp stalled {int(stall)}s")
            t.join(timeout=0.4)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _kill_proc(proc)
        return tail

    def _find_output(self, job_id: str) -> Path | None:
        cands = sorted(self.download_dir.glob(f"{job_id}.*"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in cands:
            if p.suffix.lower() in {".part", ".ytdl", ".json"}:
                continue
            if p.is_file() and p.stat().st_size > 0:
                return p
        return None

    @staticmethod
    def _python() -> str:
        import sys

        return sys.executable
