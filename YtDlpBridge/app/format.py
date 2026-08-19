"""iOS Safari lock: prefer avc1 + mp4a in mp4; recode only as fallback."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


def ios_format_selector(max_height: int = 1080) -> str:
    h = max(240, int(max_height or 1080))
    return (
        f"bv*[vcodec^=avc1][height<={h}]+ba[acodec^=mp4a]/"
        f"bv*[vcodec^=avc1][height<={h}]+ba/"
        f"b[ext=mp4][vcodec^=avc1][height<={h}]/"
        f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"
    )


def ios_sort_order() -> str:
    return "res,vcodec:h264,acodec:aac,ext:mp4:m4a"


def which_deno() -> str | None:
    return shutil.which("deno")


def ytdlp_base_args(
    *,
    max_height: int = 1080,
    cookies_file: str = "",
    cookies_from_browser: str = "",
    deno: str | None = None,
    proxy: str = "",
) -> list[str]:
    args = [
        "--no-playlist",
        "--newline",
        "-f",
        ios_format_selector(max_height),
        "-S",
        ios_sort_order(),
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--ppa",
        "ffmpeg:-movflags +faststart",
        "--socket-timeout",
        "45",
        "--retries",
        "2",
        "--fragment-retries",
        "3",
        "--extractor-retries",
        "2",
        "--no-mtime",
    ]
    runtime = deno if deno is not None else which_deno()
    if runtime:
        args.extend(["--js-runtimes", f"deno:{runtime}"])
    if cookies_file:
        args.extend(["--cookies", cookies_file])
    elif cookies_from_browser:
        args.extend(["--cookies-from-browser", cookies_from_browser])
    # Logged-in YouTube currently breaks tv_downgraded ("The page needs to be reloaded").
    if cookies_file or cookies_from_browser:
        args.extend(["--extractor-args", "youtube:player_client=default,web_embedded"])
    if proxy:
        args.extend(["--proxy", proxy])
    return args


def which_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def which_ffprobe() -> str | None:
    return shutil.which("ffprobe")


def probe_codecs(path: Path) -> dict[str, str]:
    ffprobe = which_ffprobe()
    if not ffprobe or not path.is_file():
        return {}
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        str(path),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=60)
        data = json.loads(out.decode("utf-8", errors="replace"))
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return {}
    video = audio = ""
    for s in data.get("streams") or []:
        if not isinstance(s, dict):
            continue
        kind = s.get("codec_type")
        name = str(s.get("codec_name") or "").lower()
        if kind == "video" and not video:
            video = name
        elif kind == "audio" and not audio:
            audio = name
    return {"video": video, "audio": audio, "ext": path.suffix.lower().lstrip(".")}


def is_ios_playable(probe: dict[str, str]) -> bool:
    v = (probe.get("video") or "").lower()
    a = (probe.get("audio") or "").lower()
    ext = (probe.get("ext") or "").lower()
    if ext and ext not in {"mp4", "m4v", "mov"}:
        return False
    ok_v = v in {"h264", "avc1", "avc"}
    ok_a = (not a) or a in {"aac", "mp4a", "mp3"}
    return ok_v and ok_a


def recode_to_ios(src: Path, dest: Path) -> None:
    ffmpeg = which_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found on PATH")
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    subprocess.check_call(cmd, timeout=3600)


def ensure_faststart(src: Path) -> Path:
    """Cheap copy remux so moov is at the start. Skip if ffmpeg fails or not mp4-like."""
    if not src.is_file():
        return src
    if src.suffix.lower() not in {".mp4", ".m4v", ".mov"}:
        return src
    ffmpeg = which_ffmpeg()
    if not ffmpeg:
        return src
    dest = src.with_name(src.stem + ".fs" + src.suffix)
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(src),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(dest),
    ]
    try:
        subprocess.check_call(cmd, timeout=300)
    except (subprocess.SubprocessError, OSError):
        if dest.is_file():
            try:
                dest.unlink()
            except OSError:
                pass
        return src
    if not dest.is_file() or dest.stat().st_size < 32:
        if dest.is_file():
            try:
                dest.unlink()
            except OSError:
                pass
        return src
    try:
        src.unlink()
    except OSError:
        pass
    final = src
    try:
        dest.replace(final)
        return final
    except OSError:
        return dest if dest.is_file() else src
