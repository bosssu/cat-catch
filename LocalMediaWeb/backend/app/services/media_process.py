"""Remux / merge uploaded capture blobs into mobile+desktop playable files."""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.core.config import ffmpeg_available, ffprobe_available, get_settings

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


@lru_cache(maxsize=1)
def _qsv_h264_available() -> bool:
    """True if this ffmpeg build exposes h264_qsv (Intel QSV / N5095 etc.)."""
    if not ffmpeg_available():
        return False
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        blob = (proc.stdout or "") + (proc.stderr or "")
        return "h264_qsv" in blob
    except Exception:
        return False


def _video_encode_args() -> list[str]:
    """
    Prefer hardware H.264 when configured and available; always fall back to libx264.
    """
    mode = (getattr(get_settings(), "ffmpeg_hw_encode", None) or "auto").strip().lower()
    if mode in ("qsv", "auto") and (mode == "qsv" or _qsv_h264_available()):
        # global_quality ~ CRF-like for QSV; ICQ mode is widely supported on recent ffmpeg
        return [
            "-c:v",
            "h264_qsv",
            "-global_quality",
            "23",
            "-look_ahead",
            "1",
            "-pix_fmt",
            "nv12",
        ]
    return list(_MOBILE_MP4_V)


def encode_mobile_mp4(src: Path, out: Path, *, extra_inputs: list[Path] | None = None) -> Path:
    """Force H.264/AAC progressive MP4 for mobile Safari etc. (HW encode when possible)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    def _build(v_args: list[str]) -> list[str]:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src)]
        if extra_inputs:
            for p in extra_inputs:
                cmd += ["-i", str(p)]
            cmd += ["-map", "0:v:0", "-map", "1:a:0?", "-shortest"]
        cmd += v_args + _MOBILE_MP4_A + _MOBILE_MP4_TAIL + [str(out)]
        return cmd

    preferred = _video_encode_args()
    try:
        _run_ffmpeg(_build(preferred), timeout=1800)
    except Exception as e:
        if preferred != _MOBILE_MP4_V:
            logger.warning("HW encode failed for %s (%s); fallback libx264", src.name, e)
            if out.exists():
                try:
                    out.unlink()
                except OSError:
                    pass
            _run_ffmpeg(_build(list(_MOBILE_MP4_V)), timeout=1800)
        else:
            raise
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


def _ffmpeg_concat_list_line(path: Path) -> str:
    """One line for ffmpeg concat demuxer (escape single quotes)."""
    # Prefer absolute POSIX-ish path; Windows backslashes → forward for ffmpeg
    p = str(path.resolve()).replace("\\", "/")
    p = p.replace("'", r"'\''")
    return f"file '{p}'"


def concat_videos_to_mp4(paths: list[Path], out: Path) -> Path:
    """
    Concatenate progressive video files in order into one mp4 (ffmpeg).
    Prefer stream copy; on failure re-encode with mobile-friendly H.264/AAC.
    Single input: remux/copy into ``out`` (same pipeline as multi when possible).
    """
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg not found; cannot concat videos")
    cleaned = [Path(p) for p in paths if p and Path(p).is_file() and Path(p).stat().st_size > 32]
    if not cleaned:
        raise RuntimeError("no valid input files for concat")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()

    if len(cleaned) == 1:
        # One segment: copy/remux into ``out`` without mutating the source
        src = cleaned[0]
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
            codecs = _probe_codecs(out)
            if _needs_mobile_transcode(out, codecs):
                tmp = out.with_name(out.stem + "_m.mp4")
                encode_mobile_mp4(out, tmp)
                out.unlink(missing_ok=True)
                tmp.replace(out)
        except RuntimeError:
            if out.exists():
                try:
                    out.unlink()
                except OSError:
                    pass
            encode_mobile_mp4(src, out)
        if not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError("single-file concat/remux produced empty file")
        return out

    fd_list, list_name = tempfile.mkstemp(suffix="_concat.txt", prefix="lmw_")
    try:
        import os as _os

        _os.close(fd_list)
    except OSError:
        pass
    list_path = Path(list_name)
    try:
        list_path.write_text(
            "\n".join(_ffmpeg_concat_list_line(p) for p in cleaned) + "\n",
            encoding="utf-8",
        )
        # 1) stream copy
        cmd_copy = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out),
        ]
        try:
            _run_ffmpeg(cmd_copy, timeout=max(600, 120 * len(cleaned)))
            codecs = _probe_codecs(out)
            if _needs_mobile_transcode(out, codecs):
                tmp = out.with_name(out.stem + "_m.mp4")
                encode_mobile_mp4(out, tmp)
                out.unlink(missing_ok=True)
                tmp.replace(out)
        except RuntimeError as e1:
            logger.info("concat copy failed, re-encoding: %s", e1)
            if out.exists():
                try:
                    out.unlink()
                except OSError:
                    pass
            # 2) re-encode whole concat (handles mixed codecs / missing indices)
            cmd_enc = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_path),
                *_video_encode_args(),
                *_MOBILE_MP4_A,
                *_MOBILE_MP4_TAIL,
                str(out),
            ]
            try:
                _run_ffmpeg(cmd_enc, timeout=max(900, 180 * len(cleaned)))
            except RuntimeError:
                # 3) normalize each segment then copy-concat
                norm_dir = Path(tempfile.mkdtemp(prefix="lmw_concat_norm_"))
                try:
                    norms: list[Path] = []
                    for i, p in enumerate(cleaned):
                        n = norm_dir / f"part_{i:04d}.mp4"
                        encode_mobile_mp4(p, n)
                        norms.append(n)
                    list_path.write_text(
                        "\n".join(_ffmpeg_concat_list_line(p) for p in norms) + "\n",
                        encoding="utf-8",
                    )
                    if out.exists():
                        out.unlink()
                    _run_ffmpeg(cmd_copy, timeout=max(600, 120 * len(norms)))
                finally:
                    try:
                        shutil.rmtree(norm_dir, ignore_errors=True)
                    except Exception:
                        pass
    finally:
        try:
            list_path.unlink(missing_ok=True)
        except OSError:
            pass

    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError("concat produced empty file")
    return out


def probe_single_file_role(path: Path) -> dict[str, Any]:
    """
    Classify a complete local file for A/V pairing.
    role: video_only | audio_only | av | unknown
    duration_sec: primary timeline length (prefer stream, else format)
    """
    out: dict[str, Any] = {
        "role": "unknown",
        "duration_sec": None,
        "has_video": False,
        "has_audio": False,
        "error": "",
        "summary": "",
    }
    info = probe_av_timeline(path)
    out["has_video"] = bool(info.has_video)
    out["has_audio"] = bool(info.has_audio)
    out["error"] = info.error or ""
    out["summary"] = info.summary()
    if info.has_video and info.has_audio:
        out["role"] = "av"
        # Prefer video duration when both present
        out["duration_sec"] = info.v_duration or info.format_duration or info.a_duration
    elif info.has_video:
        out["role"] = "video_only"
        out["duration_sec"] = info.v_duration or info.format_duration
    elif info.has_audio:
        out["role"] = "audio_only"
        out["duration_sec"] = info.a_duration or info.format_duration
    else:
        out["role"] = "unknown"
        out["duration_sec"] = info.format_duration
    return out


def sniff_image_kind(path: Path) -> str | None:
    """
    Magic-byte image detection (no extension). Returns 'gif' | 'image' | None.
    """
    try:
        with path.open("rb") as f:
            head = f.read(32)
    except OSError:
        return None
    if len(head) < 12:
        return None
    if head[:3] == b"\xff\xd8\xff":
        return "image"  # JPEG
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:2] == b"BM":
        return "image"  # BMP
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image"
    # ISO BMFF (AVIF / HEIC) — treat still as image when ftyp avif/heic
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis", b"heic", b"heif", b"mif1"):
            return "image"
    return None


def _guess_mime_for_type(path: Path, media_type: str) -> str:
    import mimetypes

    mime = mimetypes.guess_type(path.name)[0] or ""
    if media_type == "audio":
        if not mime or mime.startswith("video/"):
            # disguised audio often stored as .mp4 — prefer audio/mp4 over video/mp4
            suf = path.suffix.lower()
            if suf in (".mp4", ".m4a", ".m4b", ".mp4a"):
                return "audio/mp4"
            if suf == ".webm":
                return "audio/webm"
            return mime or "audio/mpeg"
        return mime
    if media_type == "video":
        return mime or "video/mp4"
    if media_type == "gif":
        return mime or "image/gif"
    if media_type == "image":
        return mime or "image/jpeg"
    return mime or "application/octet-stream"


def classify_media_file(
    path: Path,
    *,
    hinted: str | None = None,
    content_type: str | None = None,
) -> dict[str, Any]:
    """
    Content-based media_type (does NOT trust file extension).

    Priority:
      1. Image magic bytes
      2. ffprobe streams (audio_only → audio; any video stream → video)
      3. Weak fallbacks: Content-Type, then hinted type, then 'video'

    Returns dict with: media_type, role, has_video, has_audio, duration_sec,
    mime, method, error, summary
    """
    hinted_l = (hinted or "").strip().lower() or None
    ct = (content_type or "").lower()
    result: dict[str, Any] = {
        "media_type": "video",
        "role": "unknown",
        "has_video": False,
        "has_audio": False,
        "duration_sec": None,
        "mime": "",
        "method": "fallback",
        "error": "",
        "summary": "",
    }
    if not path or not path.is_file():
        result["error"] = "missing"
        if hinted_l in ("image", "gif", "video", "audio"):
            result["media_type"] = hinted_l
        result["mime"] = _guess_mime_for_type(path or Path("x.bin"), result["media_type"])
        return result
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    if size < 8:
        result["error"] = "empty"
        result["media_type"] = hinted_l if hinted_l in ("image", "gif", "video", "audio") else "video"
        result["mime"] = _guess_mime_for_type(path, result["media_type"])
        return result

    # 1) Still images by magic (extension may be .bin / .mp4 spoof — rare but cheap)
    img_kind = sniff_image_kind(path)
    if img_kind:
        result["media_type"] = img_kind
        result["role"] = "image"
        result["method"] = "magic"
        result["mime"] = _guess_mime_for_type(path, img_kind)
        return result

    # 2) ffprobe stream topology — authoritative for A/V (handles audio-in-.mp4)
    if ffprobe_available() or ffmpeg_available():
        role_info = probe_single_file_role(path)
        result["role"] = role_info.get("role") or "unknown"
        result["has_video"] = bool(role_info.get("has_video"))
        result["has_audio"] = bool(role_info.get("has_audio"))
        result["duration_sec"] = role_info.get("duration_sec")
        result["summary"] = role_info.get("summary") or ""
        result["error"] = role_info.get("error") or ""
        role = result["role"]
        if role == "audio_only" or (result["has_audio"] and not result["has_video"]):
            result["media_type"] = "audio"
            result["method"] = "ffprobe"
            result["mime"] = _guess_mime_for_type(path, "audio")
            return result
        if role in ("video_only", "av") or result["has_video"]:
            result["media_type"] = "video"
            result["method"] = "ffprobe"
            result["mime"] = _guess_mime_for_type(path, "video")
            return result
        # probe ran but no streams — fall through
        if not result["error"]:
            result["error"] = "no_av_streams"
    else:
        result["error"] = "ffprobe_unavailable"

    # 3) Weak fallbacks (only when content probe failed)
    if ct.startswith("audio/"):
        result["media_type"] = "audio"
        result["method"] = "content_type"
    elif ct.startswith("image/gif") or "gif" in ct:
        result["media_type"] = "gif"
        result["method"] = "content_type"
    elif ct.startswith("image/"):
        result["media_type"] = "image"
        result["method"] = "content_type"
    elif ct.startswith("video/"):
        result["media_type"] = "video"
        result["method"] = "content_type"
    elif hinted_l in ("image", "gif", "video", "audio"):
        result["media_type"] = hinted_l
        result["method"] = "hint"
    else:
        result["media_type"] = "video"
        result["method"] = "fallback"
    result["mime"] = _guess_mime_for_type(path, result["media_type"])
    return result


def duration_match_score(
    d1: float | None,
    d2: float | None,
    *,
    abs_tol: float = 0.45,
    rel_tol: float = 0.02,
) -> float | None:
    """
    Return match score in [0,1] if within tolerance, else None.
    High score = closer durations.
    """
    if d1 is None or d2 is None:
        return None
    try:
        a = float(d1)
        b = float(d2)
    except (TypeError, ValueError):
        return None
    if a <= 0.05 or b <= 0.05:
        return None
    delta = abs(a - b)
    base = max(a, b)
    if delta > abs_tol and delta / base > rel_tol:
        return None
    # Score: 1 when identical, decays with relative error
    score = 1.0 - min(1.0, delta / max(base, 1e-6))
    return float(score)


def match_av_by_duration(
    videos: list[dict[str, Any]],
    audios: list[dict[str, Any]],
    *,
    abs_tol: float = 0.45,
    rel_tol: float = 0.02,
    min_score: float = 0.97,
) -> list[dict[str, Any]]:
    """
    Greedy bipartite match: each video/audio used at most once.
    videos/audios items need: id, duration_sec, title (optional)
    """
    candidates: list[tuple[float, dict[str, Any]]] = []
    for v in videos:
        vd = v.get("duration_sec")
        for a in audios:
            ad = a.get("duration_sec")
            sc = duration_match_score(vd, ad, abs_tol=abs_tol, rel_tol=rel_tol)
            if sc is None or sc < min_score:
                continue
            candidates.append(
                (
                    sc,
                    {
                        "video_id": int(v["id"]),
                        "audio_id": int(a["id"]),
                        "video_duration": float(vd),
                        "audio_duration": float(ad),
                        "delta_sec": float(vd) - float(ad),
                        "score": round(sc, 5),
                        "video_title": v.get("title") or "",
                        "audio_title": a.get("title") or "",
                    },
                )
            )
    candidates.sort(key=lambda x: (-x[0], abs(x[1]["delta_sec"])))
    used_v: set[int] = set()
    used_a: set[int] = set()
    pairs: list[dict[str, Any]] = []
    for sc, pair in candidates:
        vid = pair["video_id"]
        aid = pair["audio_id"]
        if vid in used_v or aid in used_a:
            continue
        used_v.add(vid)
        used_a.add(aid)
        pair = dict(pair)
        pair["pair_index"] = len(pairs)
        pairs.append(pair)
    return pairs


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


# async=N: stretch/squeeze up to N samples per correction for mid-stream drift / gaps
_AV_AFILTER_SOFT = "aresample=async=1000:first_pts=0"
_AV_AFILTER_HARD = "aresample=async=1000:min_hard_comp=0.100:first_pts=0"


def _run_align_ffmpeg(
    src: Path,
    out: Path,
    *,
    reencode_video: bool,
    hard: bool = False,
    has_audio: bool = True,
    has_video: bool = True,
) -> None:
    """
    Write aligned progressive mp4 to out.

    - soft: video copy (or reencode if requested) + AAC with aresample async
    - hard: discard corrupt, regenerate PTS, full H.264+AAC, CFR video clock
      (best recovery after HLS DISCONTINUITY / missing mid segments)
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    cmd: list[str] = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
    ]
    if hard:
        # Tolerate broken mid-stream timestamps from concat gaps / DISCONTINUITY
        cmd += [
            "-fflags",
            "+genpts+igndts+discardcorrupt",
            "-err_detect",
            "ignore_err",
            "-analyzeduration",
            "100M",
            "-probesize",
            "100M",
        ]
    else:
        cmd += ["-fflags", "+genpts"]
    cmd += ["-i", str(src)]
    if has_video:
        cmd += ["-map", "0:v:0?"]
    if has_audio:
        cmd += ["-map", "0:a:0?"]
    if has_video:
        if reencode_video or hard:
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
                # Rebuild continuous video clock (kills mid-file A/V drift after gaps)
                # -vsync for older ffmpeg; -fps_mode on newer — use vsync for wider support
                "-vsync",
                "cfr",
            ]
        else:
            cmd += ["-c:v", "copy"]
    else:
        cmd += ["-vn"]
    if has_audio:
        cmd += [
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-af",
            _AV_AFILTER_HARD if hard else _AV_AFILTER_SOFT,
        ]
    else:
        cmd += ["-an"]
    cmd += [
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        # Drop non-media that confuses players after mid-HLS cut
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        str(out),
    ]
    _run_ffmpeg(cmd, timeout=3600)


def before_av_not_ok(report: dict[str, Any] | None) -> bool:
    """True when pre-align probe shows skew, error, or uncertain timeline."""
    if not report:
        return False
    before = report.get("before") or {}
    if not before:
        return False
    if before.get("error"):
        return True
    if before.get("uncertain"):
        return True
    return bool(before.get("skew"))


def _timeline_uncertain(info: AvTimelineInfo) -> bool:
    """True when probe cannot confidently claim A/V are aligned."""
    if info.error:
        return True
    if not (info.has_video and info.has_audio):
        return False
    # Both fell back to format duration → stream clocks unknown
    if info.v_duration is None or info.a_duration is None:
        return True
    # start_time completely missing on either side after mux
    if info.v_start is None or info.a_start is None:
        return True
    return False


def align_av_timeline(
    src: Path,
    *,
    threshold: float = AV_SKEW_THRESHOLD_SEC,
    force: bool = False,
    hard: bool = False,
) -> tuple[Path, dict[str, Any]]:
    """
    Probe A/V timeline and re-time so audio tracks the video clock.

    Used after HLS segment concat / clip (before library ingest + jasna).

    - force=False: remux only when probe reports skew / error / uncertain.
    - force=True: always run align remux (HLS default — probe often false-clean).
    - hard=True: skip soft copy path; full H.264+AAC re-encode with CFR
      (partial download, DISCONTINUITY, mid-gap, or soft still skew).

    Returns (final_path, debug_report) with before/after probe for logs/UI.
    """
    report: dict[str, Any] = {
        "action": "none",
        "threshold": threshold,
        "force": force,
        "hard": hard,
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
    bd = before.as_dict()
    uncertain = _timeline_uncertain(before)
    bd["uncertain"] = uncertain
    report["before"] = bd
    logger.info(
        "av-timeline BEFORE %s | %s%s",
        src.name,
        before.summary(),
        " UNCERTAIN" if uncertain else "",
    )

    need = force or hard or before.skew or bool(before.error) or uncertain
    # Video-only: still remux to mp4+faststart if .ts
    if not before.has_audio and before.has_video and src.suffix.lower() in (".ts", ".m2ts"):
        need = True
    if not need:
        report["action"] = "skip_clean"
        report["ok"] = True
        report["note"] = "already_aligned"
        report["after"] = bd
        return src, report

    if not before.has_video and not before.has_audio:
        report["action"] = "skip_no_streams"
        report["note"] = before.error or "no_av"
        report["ok"] = False
        return src, report

    work_out = src.with_name(src.stem + ".__avfix.mp4")
    has_a = bool(before.has_audio)
    has_v = bool(before.has_video)
    action = "hard_reencode_v_async_a" if hard else "copy_v_async_a"
    try:
        if hard:
            _run_align_ffmpeg(
                src,
                work_out,
                reencode_video=True,
                hard=True,
                has_audio=has_a,
                has_video=has_v,
            )
        else:
            try:
                _run_align_ffmpeg(
                    src,
                    work_out,
                    reencode_video=False,
                    hard=False,
                    has_audio=has_a,
                    has_video=has_v,
                )
            except Exception as e1:
                logger.warning(
                    "av align (copy video) failed %s: %s — reencode", src.name, e1
                )
                if work_out.exists():
                    try:
                        work_out.unlink()
                    except OSError:
                        pass
                action = "reencode_v_async_a"
                _run_align_ffmpeg(
                    src,
                    work_out,
                    reencode_video=True,
                    hard=False,
                    has_audio=has_a,
                    has_video=has_v,
                )
    except Exception as e2:
        # Last resort: hard path even if we already tried soft reencode
        if not hard:
            logger.warning("av align soft failed %s: %s — hard", src.name, e2)
            if work_out.exists():
                try:
                    work_out.unlink()
                except OSError:
                    pass
            action = "hard_reencode_v_async_a"
            try:
                _run_align_ffmpeg(
                    src,
                    work_out,
                    reencode_video=True,
                    hard=True,
                    has_audio=has_a,
                    has_video=has_v,
                )
            except Exception as e3:
                logger.warning("av align hard failed %s: %s", src.name, e3)
                report["action"] = "failed"
                report["note"] = f"align_failed:{e3}"[:300]
                report["ok"] = False
                report["after"] = bd
                return src, report
        else:
            logger.warning("av align hard failed %s: %s", src.name, e2)
            report["action"] = "failed"
            report["note"] = f"align_failed:{e2}"[:300]
            report["ok"] = False
            report["after"] = bd
            return src, report

    if not work_out.is_file() or work_out.stat().st_size < 64:
        report["action"] = "failed"
        report["note"] = "align_empty_output"
        report["ok"] = False
        report["after"] = bd
        try:
            work_out.unlink(missing_ok=True)
        except OSError:
            pass
        return src, report

    after = probe_av_timeline(work_out, threshold=threshold)
    after_d = after.as_dict()
    after_d["uncertain"] = _timeline_uncertain(after)
    report["after"] = after_d
    report["action"] = action
    report["ok"] = (not after.skew) and after.has_video and not after.error
    logger.info(
        "av-timeline AFTER  %s | %s | action=%s ok=%s",
        work_out.name,
        after.summary(),
        action,
        report["ok"],
    )

    # Soft path still skew → escalate to hard re-encode on the soft output
    if (
        not hard
        and before.has_audio
        and after.has_video
        and (after.skew or after.error)
    ):
        hard_out = src.with_name(src.stem + ".__avhard.mp4")
        try:
            _run_align_ffmpeg(
                work_out,
                hard_out,
                reencode_video=True,
                hard=True,
                has_audio=has_a,
                has_video=has_v,
            )
            if hard_out.is_file() and hard_out.stat().st_size > 64:
                after2 = probe_av_timeline(hard_out, threshold=threshold)
                after2_d = after2.as_dict()
                after2_d["uncertain"] = _timeline_uncertain(after2)
                # Prefer hard result if better or equal ok
                hard_ok = (not after2.skew) and after2.has_video and not after2.error
                if hard_ok or not report["ok"]:
                    try:
                        work_out.unlink(missing_ok=True)
                    except OSError:
                        pass
                    work_out = hard_out
                    after = after2
                    after_d = after2_d
                    report["after"] = after_d
                    report["action"] = "hard_after_soft_skew"
                    report["ok"] = hard_ok
                    logger.info(
                        "av-timeline HARD   %s | %s | ok=%s",
                        hard_out.name,
                        after2.summary(),
                        hard_ok,
                    )
                else:
                    hard_out.unlink(missing_ok=True)
        except Exception as e_hard:
            logger.warning("av hard escalate failed %s: %s", src.name, e_hard)
            try:
                hard_out.unlink(missing_ok=True)
            except OSError:
                pass

    # Prefer progressive .mp4 next to src (replace in place when src already mp4)
    final = src if src.suffix.lower() == ".mp4" else src.with_suffix(".mp4")
    try:
        if final.resolve() != work_out.resolve():
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
        report["after"] = after.as_dict() if hasattr(after, "as_dict") else after_d
        return work_out, report

    # Compact note for job.warning UI
    bsum = before.summary()
    asum = after.summary()
    flag = "ok" if report["ok"] else "still_skew"
    report["note"] = f"avfix:{report['action']} {flag} before[{bsum}] after[{asum}]"
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
