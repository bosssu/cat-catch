from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from app.core.config import ffmpeg_available, get_settings


def thumb_path_for(media_id: int) -> Path:
    return get_settings().thumbs_path() / f"{media_id}.jpg"


def generate_thumb(src: Path, media_id: int, media_type: str) -> str:
    """Return relative thumb path under data/ or empty string."""
    dest = thumb_path_for(media_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if media_type == "audio":
            # No video frame; frontend uses a CSS/SVG note placeholder.
            return ""
        if media_type in ("image", "gif"):
            from PIL import Image

            with Image.open(src) as im:
                im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
                im.thumbnail((400, 400))
                im.save(dest, "JPEG", quality=85)
            return f"thumbs/{media_id}.jpg"
        if media_type in ("video", "m3u8") and ffmpeg_available():
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                "1",
                "-i",
                str(src),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                str(dest),
            ]
            subprocess.run(
                cmd,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
            )
            if dest.is_file() and dest.stat().st_size > 0:
                return f"thumbs/{media_id}.jpg"
    except Exception:
        if dest.exists():
            dest.unlink(missing_ok=True)
    return ""
