"""Extract a still frame from a local video for grid/preview thumbnails."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

from app.core.config import ROOT

_THUMB_DIR = ROOT / "data" / "tmp" / "vid_thumbs"

# Skip ffmpeg for huge files on the UI path (would freeze the grid).
_MAX_SYNC_BYTES = 80 * 1024 * 1024  # 80 MiB
_FFMPEG_TIMEOUT = 8


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def video_thumbnail(
    local_path: str | Path,
    *,
    at_sec: float = 0.5,
    allow_slow: bool = False,
) -> Path | None:
    """
    Return path to a JPEG thumbnail, or None if unavailable.
    Caches by file path + mtime + size.

    By default refuses to run ffmpeg on large files / blocks briefly only.
    Set allow_slow=True for background workers.
    """
    src = Path(local_path)
    if not src.is_file():
        return None
    try:
        st = src.stat()
    except OSError:
        return None
    key = hashlib.sha1(f"{src.resolve()}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()[:16]
    _THUMB_DIR.mkdir(parents=True, exist_ok=True)
    out = _THUMB_DIR / f"{key}.jpg"
    if out.is_file() and out.stat().st_size > 100:
        return out

    if not allow_slow and st.st_size > _MAX_SYNC_BYTES:
        return None

    ff = _ffmpeg()
    if not ff:
        return None
    try:
        # -ss before -i is faster for seek; scale down for speed
        cmd = [
            ff,
            "-y",
            "-ss",
            str(max(0.0, at_sec)),
            "-i",
            str(src),
            "-frames:v",
            "1",
            "-vf",
            "scale=320:-1",
            "-q:v",
            "6",
            str(out),
        ]
        r = subprocess.run(
            cmd,
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT if not allow_slow else 30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if r.returncode == 0 and out.is_file() and out.stat().st_size > 100:
            return out
        if out.exists():
            out.unlink(missing_ok=True)
    except Exception:
        if out.exists():
            try:
                out.unlink(missing_ok=True)
            except OSError:
                pass
    return None
