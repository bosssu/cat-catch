"""Remux / merge uploaded capture blobs into mobile+desktop playable files."""
from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from app.core.config import ffmpeg_available

logger = logging.getLogger("lmw.media_process")

# H.264 Main + AAC in progressive MP4 — widest HTML5 support (iOS Safari / Android / desktop)
_MOBILE_MP4_V = [
    "-c:v",
    "libx264",
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "23",
]
_MOBILE_MP4_A = [
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "44100",
]
_MOBILE_MP4_TAIL = ["-movflags", "+faststart"]


def _run_ffmpeg(cmd: list[str], timeout: int = 600) -> None:
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "")[-800:]
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {err}")


def _probe_codecs(path: Path) -> str:
    """Return lowercase codec names from ffprobe, or empty string."""
    if not path.is_file():
        return ""
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name,codec_type",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        return (proc.stdout or "").lower()
    except Exception:
        return ""


def _needs_mobile_transcode(src: Path, codec_blob: str) -> bool:
    """
    True when container/codecs are risky on mobile (esp. iOS):
    webm/vp8/vp9/av1/opus/vorbis/hevc, or probe failed on non-mp4.
    """
    suf = src.suffix.lower()
    if suf in (".webm", ".mkv", ".ts", ".m4s", ".bin", ".dat"):
        return True
    if not codec_blob:
        # unknown — safer to leave copy attempt first, caller decides
        return suf != ".mp4"
    bad = ("vp8", "vp9", "av01", "av1", "opus", "vorbis", "hevc", "h265", "theora", "mpeg4")
    return any(b in codec_blob for b in bad)


def encode_mobile_mp4(src: Path, out: Path, *, extra_inputs: list[Path] | None = None) -> Path:
    """Force H.264/AAC progressive MP4 for mobile Safari etc."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
    if extra_inputs:
        for p in extra_inputs:
            cmd += ["-i", str(p)]
        cmd += ["-map", "0:v:0", "-map", "1:a:0?", "-shortest"]
    cmd += _MOBILE_MP4_V + _MOBILE_MP4_A + _MOBILE_MP4_TAIL + [str(out)]
    _run_ffmpeg(cmd, timeout=1800)
    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError("mobile encode produced empty file")
    return out


def remux_to_playable(src: Path, prefer_ext: str | None = None) -> Path:
    """
    Produce a progressive MP4 that plays on mobile + desktop.
    WebM/VP9/Opus always transcoded to H.264/AAC.
    """
    if not src.is_file() or src.stat().st_size < 32:
        return src
    if not ffmpeg_available():
        logger.warning("ffmpeg missing; skip remux for %s", src.name)
        return src

    # Always target mp4 for library playback (iOS cannot play webm)
    out_ext = "mp4"
    out = src.with_name(src.stem + f"_play.{out_ext}")
    if out.exists():
        out.unlink()

    def _finalize(produced: Path) -> Path:
        try:
            src.unlink(missing_ok=True)
        except OSError:
            pass
        final = src.with_suffix(f".{out_ext}")
        # if src was already .mp4, final may equal original path after unlink
        if final.exists() and final != produced:
            try:
                final.unlink()
            except OSError:
                pass
        if produced != final:
            produced.replace(final)
        return final

    codecs = _probe_codecs(src)
    force_x264 = _needs_mobile_transcode(src, codecs)

    if force_x264:
        try:
            encode_mobile_mp4(src, out)
            return _finalize(out)
        except Exception as e:
            logger.warning("mobile encode failed for %s: %s", src.name, e)
            if out.exists():
                try:
                    out.unlink()
                except OSError:
                    pass
            return src

    # Prefer stream copy + faststart when codecs already mobile-friendly
    cmd = [
        "ffmpeg",
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
        str(out),
    ]
    try:
        _run_ffmpeg(cmd)
        if out.is_file() and out.stat().st_size > 0:
            return _finalize(out)
    except Exception as e:
        logger.warning("remux copy failed for %s: %s — try mobile encode", src.name, e)
        if out.exists():
            try:
                out.unlink()
            except OSError:
                pass

    try:
        encode_mobile_mp4(src, out)
        return _finalize(out)
    except Exception as e2:
        logger.warning("mobile encode failed for %s: %s", src.name, e2)
        if out.exists():
            try:
                out.unlink()
            except OSError:
                pass
    return src


def merge_av_to_mp4(video: Path, audio: Path | None, out: Path) -> Path:
    """Merge separate MSE video/audio tracks into one progressive H.264/AAC mp4."""
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg not found; cannot merge A/V capture")
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    # Try copy first (fast), then force mobile-friendly re-encode
    if audio and audio.is_file() and audio.stat().st_size > 0:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video),
            "-i",
            str(audio),
            "-c",
            "copy",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out),
        ]
    else:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out),
        ]
    try:
        _run_ffmpeg(cmd)
        # Even if copy works, re-check codecs for mobile (e.g. hevc)
        codecs = _probe_codecs(out)
        if _needs_mobile_transcode(out, codecs):
            tmp = out.with_name(out.stem + "_m.mp4")
            encode_mobile_mp4(out, tmp)
            out.unlink(missing_ok=True)
            tmp.replace(out)
    except RuntimeError:
        extras = [audio] if audio and audio.is_file() else None
        if extras:
            encode_mobile_mp4(video, out, extra_inputs=extras)
        else:
            encode_mobile_mp4(video, out)

    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError("merge produced empty file")
    return out


def write_temp_bytes(data: bytes, suffix: str) -> Path:
    fd, name = tempfile.mkstemp(suffix=suffix)
    path = Path(name)
    try:
        import os

        os.close(fd)
    except OSError:
        pass
    path.write_bytes(data)
    return path
