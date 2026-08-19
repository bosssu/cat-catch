"""Pure URL / yt-dlp download helpers (no Qt)."""

from __future__ import annotations

import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

_MEDIA_EXTS = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".bmp",
        ".tif",
        ".tiff",
        ".avif",
        ".heic",
        ".jfif",
        ".gif",
        ".mp4",
        ".webm",
        ".mkv",
        ".mov",
        ".m4v",
        ".avi",
        ".ts",
        ".m3u8",
        ".mpd",
        ".mp3",
        ".m4a",
        ".aac",
        ".ogg",
        ".wav",
        ".flac",
        ".opus",
        ".wma",
    }
)

_PATH_MEDIA_RE = re.compile(
    r"\.(jpe?g|png|webp|gif|bmp|avif|heic|jfif|tif{1,2}|mp4|webm|mkv|mov|m4v|avi|ts|"
    r"m3u8|mpd|mp3|m4a|aac|ogg|wav|flac|opus|wma)(?:$|[?#/])",
    re.I,
)

_CDN_HOST_HINTS = (
    "cdn.discordapp.com",
    "media.discordapp.net",
    "cdn.discord.com",
    "i.imgur.com",
    "media.tenor.com",
    "c.tenor.com",
    "pbs.twimg.com",
    "video.twimg.com",
    "i.ytimg.com",
)

_SAFE_NAME_RE = re.compile(r"[^\w.\-()+ ]+", re.UNICODE)


@dataclass
class DownloadResult:
    ok: bool
    path: str | None
    error: str = ""
    method: str = ""  # direct | ytdlp


def is_direct_media_url(url: str) -> bool:
    """True if URL path looks like a direct media asset (or known CDN attachment)."""
    if not url or not isinstance(url, str):
        return False
    u = url.strip()
    if not u.lower().startswith(("http://", "https://")):
        return False
    try:
        parsed = urlparse(u)
    except Exception:
        return False
    path = unquote(parsed.path or "")
    lower_path = path.lower()
    # extension on last path segment
    name = lower_path.rsplit("/", 1)[-1]
    if "." in name:
        ext = "." + name.rsplit(".", 1)[-1]
        # strip query-like junk from ext
        ext = ext.split("?")[0]
        if ext in _MEDIA_EXTS:
            return True
    if _PATH_MEDIA_RE.search(path):
        return True
    host = (parsed.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    for h in _CDN_HOST_HINTS:
        if host == h or host.endswith("." + h):
            # known media CDN with attachments / content-type-ish paths
            if "/attachments/" in lower_path or "/media/" in lower_path or "/external/" in lower_path:
                return True
            if name and "." in name:
                return True
    return False


def _safe_filename(name: str, default: str = "download.bin") -> str:
    name = (name or "").strip()
    if not name:
        return default
    # drop path components
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = unquote(name)
    name = _SAFE_NAME_RE.sub("_", name).strip(" ._")
    if not name or name in (".", ".."):
        return default
    # cap length preserving extension
    if len(name) > 180:
        if "." in name:
            stem, ext = name.rsplit(".", 1)
            name = stem[: 180 - len(ext) - 1] + "." + ext
        else:
            name = name[:180]
    return name


def _filename_from_url(url: str) -> str:
    try:
        path = unquote(urlparse(url).path or "")
    except Exception:
        path = ""
    name = path.rsplit("/", 1)[-1] if path else ""
    return _safe_filename(name or "download.bin")


def _filename_from_content_disposition(cd: str | None) -> str | None:
    if not cd:
        return None
    # filename*=UTF-8''... or filename="..."
    m = re.search(r"filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)", cd, re.I)
    if m:
        return _safe_filename(unquote(m.group(1).strip().strip('"')))
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, re.I)
    if m:
        return _safe_filename(m.group(1))
    m = re.search(r"filename\s*=\s*([^;]+)", cd, re.I)
    if m:
        return _safe_filename(m.group(1).strip().strip("'\""))
    return None


def _unique_path(dest_dir: Path, name: str) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    p = dest_dir / name
    if not p.exists():
        return p
    stem = p.stem
    suffix = p.suffix
    for i in range(1, 10_000):
        cand = dest_dir / f"{stem}_{i}{suffix}"
        if not cand.exists():
            return cand
    return dest_dir / f"{stem}_{int(time.time())}{suffix}"


def download_direct(
    url: str,
    dest_dir: Path,
    *,
    headers: dict | None = None,
    timeout: float = 120,
    max_bytes: int = 500 * 1024 * 1024,
    progress_cb=None,
) -> DownloadResult:
    """Stream download via httpx into dest_dir.

    progress_cb(downloaded: int, total: int | None, phase: str) optional.
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    req_headers = dict(headers or {})

    def _prog(done: int, total: int | None, phase: str = "direct") -> None:
        if progress_cb:
            try:
                progress_cb(done, total, phase)
            except Exception:
                pass

    try:
        with httpx.Client(follow_redirects=True, timeout=timeout) as client:
            with client.stream("GET", url, headers=req_headers) as resp:
                if resp.status_code >= 400:
                    return DownloadResult(
                        ok=False,
                        path=None,
                        error=f"HTTP {resp.status_code}",
                        method="direct",
                    )
                name = _filename_from_content_disposition(resp.headers.get("content-disposition"))
                if not name:
                    name = _filename_from_url(str(resp.url) if resp.url else url)
                # refine ext from content-type if generic
                ct = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
                if name == "download.bin" or "." not in name:
                    ext_map = {
                        "image/jpeg": ".jpg",
                        "image/png": ".png",
                        "image/webp": ".webp",
                        "image/gif": ".gif",
                        "video/mp4": ".mp4",
                        "video/webm": ".webm",
                        "audio/mpeg": ".mp3",
                        "audio/mp4": ".m4a",
                    }
                    if ct in ext_map:
                        name = _safe_filename(Path(name).stem + ext_map[ct])
                out = _unique_path(dest_dir, name)
                cl = resp.headers.get("content-length")
                expected: int | None = None
                try:
                    if cl:
                        expected = int(cl)
                except ValueError:
                    expected = None
                total = 0
                last_emit = 0
                _prog(0, expected, "direct")
                try:
                    with open(out, "wb") as f:
                        for chunk in resp.iter_bytes(chunk_size=256 * 1024):
                            if not chunk:
                                continue
                            total += len(chunk)
                            if total > max_bytes:
                                f.close()
                                try:
                                    out.unlink(missing_ok=True)
                                except OSError:
                                    pass
                                return DownloadResult(
                                    ok=False,
                                    path=None,
                                    error=f"exceeds max_bytes ({max_bytes})",
                                    method="direct",
                                )
                            f.write(chunk)
                            # report often; UI poller throttles display
                            if (
                                total - last_emit >= 64 * 1024
                                or (expected and total >= expected)
                                or last_emit == 0
                            ):
                                last_emit = total
                                _prog(total, expected, "direct")
                except Exception as e:
                    try:
                        out.unlink(missing_ok=True)
                    except OSError:
                        pass
                    return DownloadResult(ok=False, path=None, error=str(e), method="direct")
                if total <= 0:
                    try:
                        out.unlink(missing_ok=True)
                    except OSError:
                        pass
                    return DownloadResult(
                        ok=False, path=None, error="empty response body", method="direct"
                    )
                _prog(total, expected or total, "direct")
                return DownloadResult(ok=True, path=str(out.resolve()), method="direct")
    except Exception as e:
        return DownloadResult(ok=False, path=None, error=str(e), method="direct")


def _ytdlp_cmd() -> list[str] | None:
    """Return argv prefix for yt-dlp, or None if not found."""
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    # python -m yt_dlp
    import sys

    return [sys.executable, "-m", "yt_dlp"]


def _ytdlp_available() -> bool:
    if shutil.which("yt-dlp"):
        return True
    try:
        import importlib.util

        return importlib.util.find_spec("yt_dlp") is not None
    except Exception:
        return False


def download_ytdlp(
    url: str,
    dest_dir: Path,
    *,
    timeout: float = 300,
    progress_cb=None,
) -> DownloadResult:
    """Download via yt-dlp Python API (progress) or subprocess fallback."""
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    def _prog(done: int, total: int | None, phase: str = "ytdlp") -> None:
        if progress_cb:
            try:
                progress_cb(done, total, phase)
            except Exception:
                pass

    # Prefer Python API for smooth progress
    try:
        import yt_dlp  # type: ignore
    except Exception:
        yt_dlp = None  # type: ignore

    if yt_dlp is not None:
        out_tmpl = str(dest_dir / "%(title).80s.%(ext)s")
        before = {p.resolve() for p in dest_dir.iterdir()} if dest_dir.exists() else set()
        t0 = time.time()
        last_emit = [0]

        def hook(d: dict) -> None:
            status = d.get("status")
            if status == "downloading":
                done = int(d.get("downloaded_bytes") or 0)
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                total_i = int(total) if total else None
                if done - last_emit[0] >= 256 * 1024 or (total_i and done >= total_i):
                    last_emit[0] = done
                    _prog(done, total_i, "ytdlp")
            elif status == "finished":
                done = int(d.get("downloaded_bytes") or last_emit[0] or 0)
                _prog(done, done or None, "ytdlp")

        opts = {
            "format": "bv*+ba/b",
            "outtmpl": out_tmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
            "noprogress": True,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        except Exception as e:
            return DownloadResult(ok=False, path=None, error=str(e)[:500], method="ytdlp")

        after = list(dest_dir.iterdir()) if dest_dir.exists() else []
        new_files = [p for p in after if p.is_file() and p.resolve() not in before]
        if not new_files:
            new_files = [
                p
                for p in after
                if p.is_file() and p.stat().st_mtime >= t0 - 1
            ]
        if not new_files:
            return DownloadResult(
                ok=False, path=None, error="yt-dlp produced no file", method="ytdlp"
            )
        newest = max(new_files, key=lambda p: p.stat().st_mtime)
        _prog(newest.stat().st_size, newest.stat().st_size, "ytdlp")
        return DownloadResult(ok=True, path=str(newest.resolve()), method="ytdlp")

    # subprocess fallback (no fine progress)
    if not _ytdlp_available():
        return DownloadResult(
            ok=False,
            path=None,
            error="yt-dlp not installed",
            method="ytdlp",
        )
    cmd_base = _ytdlp_cmd()
    if not cmd_base:
        return DownloadResult(
            ok=False, path=None, error="yt-dlp not installed", method="ytdlp"
        )
    out_tmpl = str(dest_dir / "%(title).80s.%(ext)s")
    cmd = [
        *cmd_base,
        "-f",
        "bv*+ba/b",
        "-o",
        out_tmpl,
        "--no-playlist",
        "--no-mtime",
        "--newline",
        url,
    ]
    before = {p.resolve() for p in dest_dir.iterdir()} if dest_dir.exists() else set()
    t0 = time.time()
    _prog(0, None, "ytdlp")
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return DownloadResult(
            ok=False, path=None, error=f"yt-dlp timed out after {timeout}s", method="ytdlp"
        )
    except FileNotFoundError:
        return DownloadResult(
            ok=False, path=None, error="yt-dlp not installed", method="ytdlp"
        )
    except Exception as e:
        return DownloadResult(ok=False, path=None, error=str(e), method="ytdlp")

    after = list(dest_dir.iterdir()) if dest_dir.exists() else []
    new_files = [p for p in after if p.is_file() and p.resolve() not in before]
    if not new_files:
        candidates = [p for p in after if p.is_file()]
        new_files = [p for p in candidates if p.stat().st_mtime >= t0 - 1]
    if not new_files:
        err = (proc.stderr or proc.stdout or "").strip()
        if proc.returncode != 0:
            msg = err[:500] if err else f"yt-dlp exit {proc.returncode}"
            if "No module named" in msg or "not found" in msg.lower():
                return DownloadResult(
                    ok=False, path=None, error="yt-dlp not installed", method="ytdlp"
                )
            return DownloadResult(ok=False, path=None, error=msg, method="ytdlp")
        return DownloadResult(
            ok=False, path=None, error="yt-dlp produced no file", method="ytdlp"
        )
    newest = max(new_files, key=lambda p: p.stat().st_mtime)
    if proc.returncode != 0 and newest.stat().st_size <= 0:
        err = (proc.stderr or proc.stdout or "").strip()[:500]
        return DownloadResult(
            ok=False, path=None, error=err or f"yt-dlp exit {proc.returncode}", method="ytdlp"
        )
    _prog(newest.stat().st_size, newest.stat().st_size, "ytdlp")
    return DownloadResult(ok=True, path=str(newest.resolve()), method="ytdlp")


def resolve_to_local(
    url: str,
    dest_dir: Path,
    *,
    headers: dict | None = None,
    prefer_ytdlp: bool = True,
    timeout: float = 120,
    max_bytes: int = 500 * 1024 * 1024,
    progress_cb=None,
) -> DownloadResult:
    """Resolve a URL to a local file via direct and/or yt-dlp."""
    dest_dir = Path(dest_dir)
    if is_direct_media_url(url):
        r = download_direct(
            url,
            dest_dir,
            headers=headers,
            timeout=timeout,
            max_bytes=max_bytes,
            progress_cb=progress_cb,
        )
        if r.ok:
            return r
        if prefer_ytdlp:
            y = download_ytdlp(
                url, dest_dir, timeout=max(timeout, 300.0), progress_cb=progress_cb
            )
            if y.ok:
                return y
            return DownloadResult(
                ok=False,
                path=None,
                error=f"direct: {r.error}; ytdlp: {y.error}",
                method="direct",
            )
        return r

    if prefer_ytdlp:
        y = download_ytdlp(
            url, dest_dir, timeout=max(timeout, 300.0), progress_cb=progress_cb
        )
        if y.ok:
            return y
        r = download_direct(
            url,
            dest_dir,
            headers=headers,
            timeout=timeout,
            max_bytes=max_bytes,
            progress_cb=progress_cb,
        )
        if r.ok:
            return r
        return DownloadResult(
            ok=False,
            path=None,
            error=f"ytdlp: {y.error}; direct: {r.error}",
            method="ytdlp",
        )

    r = download_direct(
        url,
        dest_dir,
        headers=headers,
        timeout=timeout,
        max_bytes=max_bytes,
        progress_cb=progress_cb,
    )
    if r.ok:
        return r
    y = download_ytdlp(
        url, dest_dir, timeout=max(timeout, 300.0), progress_cb=progress_cb
    )
    if y.ok:
        return y
    return DownloadResult(
        ok=False,
        path=None,
        error=f"direct: {r.error}; ytdlp: {y.error}",
        method="direct",
    )


def materialize_candidate(cand: Any, dest_dir: Path, **kwargs: Any) -> DownloadResult:
    """
    Ensure candidate has a local file.
    If local_path exists as file: success.
    Elif source_url is http(s): resolve_to_local and set cand.local_path on success.
    """
    dest_dir = Path(dest_dir)
    local = getattr(cand, "local_path", None)
    if local:
        p = Path(local)
        if p.is_file():
            return DownloadResult(ok=True, path=str(p.resolve()), method="local")

    url = getattr(cand, "source_url", "") or ""
    if isinstance(url, str) and url.lower().startswith(("http://", "https://")):
        headers = kwargs.pop("headers", None)
        if headers is None:
            headers = getattr(cand, "headers", None) or None
        r = resolve_to_local(url, dest_dir, headers=headers, **kwargs)
        if r.ok and r.path:
            try:
                cand.local_path = r.path
            except Exception:
                pass
        return r

    return DownloadResult(
        ok=False,
        path=None,
        error="no local file and no http source_url",
        method="",
    )
