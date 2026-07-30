"""Remux / merge uploaded capture blobs into mobile+desktop playable files."""
from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.core.config import ffmpeg_available

logger = logging.getLogger("lmw.media_process")

# |video_dur - audio_dur| or |v_start - a_start| above this → treat as skew
AV_SKEW_THRESHOLD_SEC = 0.12

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


@dataclass
class AvTimelineInfo:
    """ffprobe snapshot of A/V timeline (for HLS clip / concat diagnostics)."""

    path: str
    has_video: bool = False
    has_audio: bool = False
    v_duration: float | None = None
    a_duration: float | None = None
    v_start: float | None = None
    a_start: float | None = None
    format_duration: float | None = None
    delta_dur: float | None = None  # video - audio duration
    delta_start: float | None = None  # video start - audio start
    skew: bool = False
    error: str = ""

    def summary(self) -> str:
        if self.error:
            return f"probe_err={self.error}"
        parts = [
            f"v={self.v_duration:.3f}s@{self.v_start or 0:.3f}"
            if self.v_duration is not None
            else "v=none",
            f"a={self.a_duration:.3f}s@{self.a_start or 0:.3f}"
            if self.a_duration is not None
            else "a=none",
        ]
        if self.delta_dur is not None:
            parts.append(f"Δdur={self.delta_dur:+.3f}s")
        if self.delta_start is not None:
            parts.append(f"Δstart={self.delta_start:+.3f}s")
        parts.append("SKEW" if self.skew else "ok")
        return " ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["summary"] = self.summary()
        return d


def _ffprobe_json(path: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,duration,start_time,nb_frames",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "ffprobe failed")[-300:]
        raise RuntimeError(err)
    return json.loads(proc.stdout or "{}")


def _fnum(v: Any) -> float | None:
    if v is None or v == "N/A" or v == "":
        return None
    try:
        x = float(v)
        if x != x:  # NaN
            return None
        return x
    except (TypeError, ValueError):
        return None


def probe_av_timeline(
    path: Path, *, threshold: float = AV_SKEW_THRESHOLD_SEC
) -> AvTimelineInfo:
    """Measure video/audio duration and start offsets; flag skew above threshold."""
    info = AvTimelineInfo(path=str(path))
    if not path.is_file() or path.stat().st_size < 32:
        info.error = "missing_or_empty"
        info.skew = True
        return info
    try:
        data = _ffprobe_json(path)
    except Exception as e:
        info.error = str(e)[:200]
        info.skew = True
        return info

    fmt = data.get("format") or {}
    info.format_duration = _fnum(fmt.get("duration"))

    for st in data.get("streams") or []:
        ctype = (st.get("codec_type") or "").lower()
        dur = _fnum(st.get("duration"))
        start = _fnum(st.get("start_time"))
        if ctype == "video" and not info.has_video:
            info.has_video = True
            info.v_duration = dur
            info.v_start = start
        elif ctype == "audio" and not info.has_audio:
            info.has_audio = True
            info.a_duration = dur
            info.a_start = start

    # Prefer stream duration; fall back to format for missing side
    if info.v_duration is None and info.has_video:
        info.v_duration = info.format_duration
    if info.a_duration is None and info.has_audio:
        info.a_duration = info.format_duration

    if info.v_duration is not None and info.a_duration is not None:
        info.delta_dur = info.v_duration - info.a_duration
    if info.v_start is not None and info.a_start is not None:
        info.delta_start = info.v_start - info.a_start

    skew = False
    if info.has_video and info.has_audio:
        if info.delta_dur is not None and abs(info.delta_dur) > threshold:
            skew = True
        if info.delta_start is not None and abs(info.delta_start) > threshold:
            skew = True
    elif info.has_video and not info.has_audio:
        # video-only is not A/V skew; leave skew False
        pass
    info.skew = skew
    return info


def _run_align_ffmpeg(src: Path, out: Path, *, reencode_video: bool) -> None:
    """Write aligned mp4 to out. Video copy first; optional full re-encode."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    cmd: list[str] = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        str(src),
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
    ]
    if reencode_video:
        cmd += [
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
            "20",
        ]
    else:
        cmd += ["-c:v", "copy"]
    cmd += [
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-ar",
        "48000",
        # Stretch/squeeze audio to video clock; reset audio PTS from 0
        "-af",
        "aresample=async=1:first_pts=0",
        "-movflags",
        "+faststart",
        # Avoid leftover chapters / odd start from mid-HLS cut
        "-avoid_negative_ts",
        "make_zero",
        str(out),
    ]
    _run_ffmpeg(cmd, timeout=3600)


def before_av_not_ok(report: dict[str, Any] | None) -> bool:
    """True when pre-align probe shows skew or probe error (worth persisting JSON)."""
    if not report:
        return False
    before = report.get("before") or {}
    if not before:
        return False
    if before.get("error"):
        return True
    return bool(before.get("skew"))


def align_av_timeline(
    src: Path,
    *,
    threshold: float = AV_SKEW_THRESHOLD_SEC,
    force: bool = False,
) -> tuple[Path, dict[str, Any]]:
    """
    Probe A/V timeline, optionally re-time so audio tracks the video clock.

    Used after HLS segment concat / clip (before library ingest + jasna).

    - force=False (default): only remux when probe reports skew / error.
    - force=True: always run align remux (debug / hard recovery).

    Returns (final_path, debug_report) where report has before/after probe
    summaries for logs and job.warning.
    """
    report: dict[str, Any] = {
        "action": "none",
        "threshold": threshold,
        "force": force,
        "before": None,
        "after": None,
        "ok": False,
        "note": "",
    }
    if not ffmpeg_available():
        report["note"] = "ffmpeg_missing"
        report["before"] = probe_av_timeline(src, threshold=threshold).as_dict()
        report["ok"] = not report["before"].get("skew")
        return src, report

    before = probe_av_timeline(src, threshold=threshold)
    report["before"] = before.as_dict()
    logger.info("av-timeline BEFORE %s | %s", src.name, before.summary())

    need = force or before.skew or bool(before.error)
    # Video-only: still remux to mp4+faststart if .ts
    if not before.has_audio and before.has_video and src.suffix.lower() in (".ts", ".m2ts"):
        need = True
    if not need:
        report["action"] = "skip_clean"
        report["ok"] = True
        report["note"] = "already_aligned"
        report["after"] = before.as_dict()
        return src, report

    if not before.has_video and not before.has_audio:
        report["action"] = "skip_no_streams"
        report["note"] = before.error or "no_av"
        report["ok"] = False
        return src, report

    work_out = src.with_name(src.stem + ".__avfix.mp4")
    action = "copy_v_async_a"
    try:
        _run_align_ffmpeg(src, work_out, reencode_video=False)
    except Exception as e1:
        logger.warning("av align (copy video) failed %s: %s — reencode", src.name, e1)
        if work_out.exists():
            try:
                work_out.unlink()
            except OSError:
                pass
        action = "reencode_v_async_a"
        try:
            _run_align_ffmpeg(src, work_out, reencode_video=True)
        except Exception as e2:
            logger.warning("av align reencode failed %s: %s", src.name, e2)
            report["action"] = "failed"
            report["note"] = f"align_failed:{e2}"[:300]
            report["ok"] = False
            report["after"] = before.as_dict()
            return src, report

    if not work_out.is_file() or work_out.stat().st_size < 64:
        report["action"] = "failed"
        report["note"] = "align_empty_output"
        report["ok"] = False
        report["after"] = before.as_dict()
        try:
            work_out.unlink(missing_ok=True)
        except OSError:
            pass
        return src, report

    after = probe_av_timeline(work_out, threshold=threshold)
    report["after"] = after.as_dict()
    report["action"] = action
    report["ok"] = (not after.skew) and after.has_video
    logger.info(
        "av-timeline AFTER  %s | %s | action=%s ok=%s",
        work_out.name,
        after.summary(),
        action,
        report["ok"],
    )

    # Prefer progressive .mp4 next to src (replace in place when src already mp4)
    final = src if src.suffix.lower() == ".mp4" else src.with_suffix(".mp4")
    try:
        if final.resolve() == work_out.resolve():
            pass
        else:
            if final.exists():
                final.unlink()
            work_out.replace(final)
        # Drop original .ts / old file if we moved to a different path
        if src.exists() and src.resolve() != final.resolve():
            try:
                src.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError as e:
        logger.warning("av align replace failed: %s — keep temp %s", e, work_out)
        report["note"] = f"replace_failed keep={work_out.name}"
        report["after"] = after.as_dict()
        return work_out, report

    # Compact note for job.warning UI
    bsum = before.summary()
    asum = after.summary()
    flag = "ok" if report["ok"] else "still_skew"
    report["note"] = f"avfix:{action} {flag} before[{bsum}] after[{asum}]"
    return final, report


def format_av_align_warning(report: dict[str, Any]) -> str:
    """Short string to append to download job / media warning."""
    if not report:
        return ""
    note = str(report.get("note") or "")
    action = str(report.get("action") or "")
    ok = report.get("ok")
    if action in ("skip_clean", "none") and ok:
        return ""
    if note:
        return note[:500]
    before = report.get("before") or {}
    after = report.get("after") or {}
    return (
        f"avfix:{action} ok={ok} "
        f"before={before.get('summary', '?')} after={after.get('summary', '?')}"
    )[:500]
