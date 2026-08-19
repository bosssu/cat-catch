"""Make cache/extension-less media files playable by Qt / system players."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from app.core.config import ROOT
from app.sources.cache_sentry import sniff_media

_PLAY_DIR = ROOT / "data" / "tmp" / "playable"

_MIME_EXT = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
}

_KNOWN_VIDEO = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".ts"}
_KNOWN_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def _ext_for(path: Path, mime: str | None = None) -> str:
    if mime and mime in _MIME_EXT:
        return _MIME_EXT[mime]
    sn = sniff_media(path)
    if sn:
        return _MIME_EXT.get(sn[1], ".bin")
    suf = path.suffix.lower()
    if suf in _KNOWN_VIDEO or suf in _KNOWN_IMAGE:
        return suf
    return ".mp4"


def ensure_playable_path(local_path: str | Path) -> Path | None:
    """
    Return a path suitable for QMediaPlayer / os.startfile.
    Discord Cache_Data files like f_000958 have no extension; copy with .mp4/.webm.
    """
    src = Path(local_path)
    if not src.is_file():
        return None
    suf = src.suffix.lower()
    if suf in _KNOWN_VIDEO or suf in _KNOWN_IMAGE:
        return src

    sn = sniff_media(src)
    if not sn:
        # still try as-is
        return src
    _mt, mime = sn
    ext = _ext_for(src, mime)
    try:
        st = src.stat()
        key = hashlib.sha1(f"{src.resolve()}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()[:16]
    except OSError:
        return src
    _PLAY_DIR.mkdir(parents=True, exist_ok=True)
    dest = _PLAY_DIR / f"{key}{ext}"
    if dest.is_file() and dest.stat().st_size == src.stat().st_size:
        return dest
    try:
        shutil.copy2(src, dest)
        return dest
    except OSError:
        return src


def try_ffmpeg_remux(src: Path, dest: Path | None = None) -> Path | None:
    """Optional remux to fix incomplete moov for Qt; returns dest or None."""
    import subprocess

    ff = shutil.which("ffmpeg")
    if not ff or not src.is_file():
        return None
    if dest is None:
        _PLAY_DIR.mkdir(parents=True, exist_ok=True)
        dest = _PLAY_DIR / f"remux_{src.stem}.mp4"
    try:
        r = subprocess.run(
            [
                ff,
                "-y",
                "-i",
                str(src),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(dest),
            ],
            capture_output=True,
            timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if r.returncode == 0 and dest.is_file() and dest.stat().st_size > 100:
            return dest
    except Exception:
        pass
    return None
