from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from app.core.config import ffmpeg_available, get_settings

# Shared note placeholder for audio (and any media without a real frame).
# Written once under data/thumbs/_audio_placeholder.jpg
AUDIO_PLACEHOLDER_NAME = "_audio_placeholder.jpg"


def thumb_path_for(media_id: int) -> Path:
    return get_settings().thumbs_path() / f"{media_id}.jpg"


def audio_placeholder_path() -> Path:
    return get_settings().thumbs_path() / AUDIO_PLACEHOLDER_NAME


def ensure_audio_placeholder() -> Path:
    """Create a small JPEG with a music-note style mark if missing."""
    dest = audio_placeholder_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    from PIL import Image, ImageDraw, ImageFont

    w = h = 400
    im = Image.new("RGB", (w, h), (18, 22, 32))
    # soft radial-ish rings via concentric ellipses
    draw = ImageDraw.Draw(im)
    for i, col in enumerate(
        (
            (42, 53, 80),
            (32, 40, 60),
            (24, 30, 46),
        )
    ):
        m = 40 + i * 36
        draw.ellipse((m, m, w - m, h - m), outline=col, width=18)
    # note glyph
    try:
        font = ImageFont.truetype("arial.ttf", 160)
    except OSError:
        try:
            font = ImageFont.truetype("segoeui.ttf", 160)
        except OSError:
            font = ImageFont.load_default()
    text = "♪"
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except Exception:
        tw, th = 80, 80
    draw.text(((w - tw) / 2, (h - th) / 2 - 12), text, fill=(200, 210, 230), font=font)
    im.save(dest, "JPEG", quality=88)
    return dest


def generate_thumb(src: Path, media_id: int, media_type: str) -> str:
    """Return relative thumb path under data/ or empty string."""
    dest = thumb_path_for(media_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if media_type == "audio":
            # Point at shared placeholder so /thumb and admin list show a real image.
            ph = ensure_audio_placeholder()
            if ph.is_file():
                return f"thumbs/{AUDIO_PLACEHOLDER_NAME}"
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
