from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from app.core.config import ffmpeg_available, get_settings
from app.services.http_client import iter_http_modes, proxy_env_for_subprocess
from app.services.media_process import (
    align_av_timeline,
    format_av_align_warning,
)
from app.services.util import is_probably_html

logger = logging.getLogger(__name__)

EXT_X_STREAM = re.compile(r"#EXT-X-STREAM-INF:([^\n]+)\n([^\n#]+)", re.MULTILINE)
EXT_X_KEY = re.compile(r'#EXT-X-KEY:METHOD=([^,]+)(?:,URI="([^"]+)")?(?:,IV=0x([0-9A-Fa-f]+))?', re.I)
EXTINF = re.compile(r"#EXTINF:([0-9.]+)")


class HlsError(Exception):
    def __init__(
        self,
        message: str,
        http_status: int = 0,
        need_client: bool = False,
        codec_reject: bool = False,
    ):
        super().__init__(message)
        self.http_status = http_status
        self.need_client = need_client
        self.codec_reject = codec_reject


def _fmt_hms(sec: float) -> str:
    s = max(0, int(round(float(sec or 0))))
    h, rem = divmod(s, 3600)
    m, sec_i = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{sec_i:02d}"
    return f"{m:02d}:{sec_i:02d}"


def _is_master(text: str) -> bool:
    return "#EXT-X-STREAM-INF" in text


_CODECS_ATTR = re.compile(r'CODECS=(?:"([^"]+)"|([^,\s]+))', re.I)


def _stream_codecs(attrs: str) -> str:
    m = _CODECS_ATTR.search(attrs or "")
    if not m:
        return ""
    return (m.group(1) or m.group(2) or "").strip()


def _pick_variant(text: str, base_url: str) -> str:
    from app.services.media_process import ios_codecs_declared_ok

    known: list[tuple[int, str, str]] = []
    unknown: list[tuple[int, str, str]] = []
    skipped: list[str] = []
    for m in EXT_X_STREAM.finditer(text):
        attrs, uri = m.group(1), m.group(2).strip()
        bw = 0
        bm = re.search(r"BANDWIDTH=(\d+)", attrs)
        if bm:
            bw = int(bm.group(1))
        codecs = _stream_codecs(attrs)
        abs_url = urljoin(base_url, uri)
        ok, detail = ios_codecs_declared_ok(codecs)
        if not ok:
            skipped.append(detail or codecs or "unknown")
            continue
        row = (bw, abs_url, codecs)
        if codecs:
            known.append(row)
        else:
            unknown.append(row)
    pool = known or unknown
    if not pool:
        if skipped:
            sample = ", ".join(skipped[:4])
            raise HlsError(
                "iPhone 13 cannot play this HLS (no H.264/HEVC variant; "
                f"CODECS={sample})",
                need_client=False,
                codec_reject=True,
            )
        raise HlsError("No variant in master playlist")
    pool.sort(key=lambda x: x[0])
    return pool[-1][1]


def _parse_media_playlist(text: str, base_url: str) -> tuple[list[dict], dict | None]:
    """Return (segments, key_info). Segments may set discontinuity=True after #EXT-X-DISCONTINUITY."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    key = None
    segments: list[dict] = []
    media_seq = 0
    pending_discontinuity = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_seq = int(line.split(":", 1)[1].strip())
            except ValueError:
                media_seq = 0
        elif line.startswith("#EXT-X-DISCONTINUITY"):
            # Next media segment starts a new timeline (ads, codec change, PCR jump)
            pending_discontinuity = True
        elif line.startswith("#EXT-X-KEY:"):
            km = EXT_X_KEY.search(line)
            if km:
                method = km.group(1).upper()
                if method == "NONE":
                    key = None
                elif method == "AES-128":
                    uri = km.group(2) or ""
                    iv = km.group(3)
                    key = {
                        "method": method,
                        "uri": urljoin(base_url, uri) if uri else "",
                        "iv": iv,
                    }
                else:
                    raise HlsError(f"Unsupported encryption METHOD={method}", need_client=True)
        elif line.startswith("#EXTINF:"):
            dur = float(EXTINF.search(line).group(1)) if EXTINF.search(line) else 0.0
            i += 1
            if i >= len(lines):
                break
            uri = lines[i]
            if uri.startswith("#"):
                continue
            seq = media_seq + len(segments)
            seg_key = key.copy() if key else None
            # Default AES-128 IV = media sequence number (16-byte big-endian) when not explicit
            if seg_key and seg_key.get("method") == "AES-128" and not seg_key.get("iv"):
                seg_key["iv"] = f"{seq:032x}"
            segments.append(
                {
                    "url": urljoin(base_url, uri),
                    "duration": dur,
                    "key": seg_key,
                    "seq": seq,
                    "discontinuity": pending_discontinuity,
                }
            )
            pending_discontinuity = False
        elif line.startswith("#EXT-X-PLAYLIST-TYPE:EVENT"):
            pass
        i += 1
    if not segments:
        raise HlsError("No segments in media playlist")
    total_dur = sum(s["duration"] for s in segments)
    settings = get_settings()
    if total_dur > settings.hls_max_duration_min * 60:
        raise HlsError(
            f"Playlist duration {total_dur:.0f}s exceeds limit "
            f"{settings.hls_max_duration_min} min"
        )
    # live sliding window heuristic: no ENDLIST and very few segments changing — reject endless live
    if "#EXT-X-ENDLIST" not in text and total_dur < 120 and len(segments) < 6:
        # short without endlist might still be vod; only reject if TARGETDURATION and no endlist long
        pass
    if "#EXT-X-ENDLIST" not in text and total_dur > 30:
        # allow but mark; for v1 still download current window only
        pass
    return segments, key


def _gap_indices(ok_indices: list[int]) -> list[int]:
    """Return missing indices strictly between first and last successful segment."""
    if len(ok_indices) < 2:
        return []
    lo, hi = ok_indices[0], ok_indices[-1]
    have = set(ok_indices)
    return [i for i in range(lo, hi + 1) if i not in have]


def _write_av_timeline_json(path: Path, av_report: dict) -> None:
    try:
        path.write_text(
            json.dumps(av_report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        logger.debug("write av_timeline.json skip: %s", e)


async def _fetch_text(client: httpx.AsyncClient, url: str, headers: dict[str, str]) -> tuple[str, int]:
    r = await client.get(url, headers=headers, follow_redirects=True)
    if r.status_code in (401, 403):
        raise HlsError(f"Playlist HTTP {r.status_code}", http_status=r.status_code, need_client=True)
    if r.status_code >= 400:
        raise HlsError(f"Playlist HTTP {r.status_code}", http_status=r.status_code)
    if is_probably_html(r.headers.get("content-type"), r.content[:200]):
        raise HlsError("Playlist URL returned HTML", http_status=r.status_code, need_client=True)
    return r.text, r.status_code


async def _download_segment(
    client: httpx.AsyncClient,
    seg: dict,
    dest: Path,
    headers: dict[str, str],
    retries: int,
) -> bool:
    last_err = None
    for attempt in range(retries):
        try:
            r = await client.get(seg["url"], headers=headers, follow_redirects=True)
            if r.status_code in (401, 403):
                last_err = r.status_code
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            if r.status_code >= 400:
                last_err = r.status_code
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            data = r.content
            key = seg.get("key")
            if key and key.get("method") == "AES-128" and key.get("uri"):
                kr = await client.get(key["uri"], headers=headers, follow_redirects=True)
                if kr.status_code >= 400:
                    last_err = kr.status_code
                    continue
                from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                from cryptography.hazmat.backends import default_backend

                key_bytes = kr.content[:16]
                if key.get("iv"):
                    iv = bytes.fromhex(key["iv"])
                else:
                    # default IV = segment sequence — approximate with zeros if unknown
                    iv = b"\x00" * 16
                decryptor = Cipher(
                    algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend()
                ).decryptor()
                data = decryptor.update(data) + decryptor.finalize()
                # strip PKCS7 padding if present
                if data:
                    pad = data[-1]
                    if 1 <= pad <= 16 and data.endswith(bytes([pad]) * pad):
                        data = data[:-pad]
            dest.write_bytes(data)
            return True
        except Exception as e:
            last_err = e
            await asyncio.sleep(0.3 * (attempt + 1))
    return False


def _slice_segments_by_time(
    segments: list[dict],
    start_sec: float | None,
    end_sec: float | None,
) -> tuple[list[dict], str]:
    """
    Keep segments overlapping [start_sec, end_sec). None end = until playlist end.
    Returns (sliced, warning note).
    """
    if not segments:
        return segments, ""
    if (start_sec is None or start_sec <= 0) and (end_sec is None or end_sec <= 0):
        return segments, ""

    s0 = max(0.0, float(start_sec or 0.0))
    total_dur = sum(float(x.get("duration") or 0) for x in segments)
    # end omitted / 0 / "to end" → playlist end (not wall-clock 00:00)
    s1 = float(end_sec) if end_sec is not None and end_sec > 0 else total_dur
    if total_dur <= 0:
        raise HlsError("Playlist has no timed segments (total duration 0)")
    if s0 >= total_dur:
        raise HlsError(
            f"Start {s0:.1f}s is past this m3u8 duration {total_dur:.1f}s "
            f"(~{_fmt_hms(total_dur)}). "
            f"「结束=末尾」uses playlist length, not the page player timeline. "
            f"Use a start earlier than {_fmt_hms(total_dur)}."
        )
    if s1 <= s0:
        raise HlsError(
            f"Invalid time range {s0:.1f}s – {s1:.1f}s "
            f"(playlist total {total_dur:.1f}s / {_fmt_hms(total_dur)}; "
            f"end must be > start, or omit end for playlist end)"
        )

    out: list[dict] = []
    t = 0.0
    for seg in segments:
        dur = float(seg.get("duration") or 0)
        seg_end = t + dur
        # include if overlaps [s0, s1)
        if seg_end > s0 and t < s1:
            out.append(seg)
        t = seg_end
        if t >= s1 and out:
            break
    if not out:
        raise HlsError(f"No segments in range {s0:.1f}s – {s1:.1f}s (total {total_dur:.1f}s)")
    note = f"clip {s0:.1f}s–{min(s1, total_dur):.1f}s / {total_dur:.1f}s ({len(out)}/{len(segments)} segs)"
    return out, note


async def _download_hls_segments(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    work_dir: Path,
    out_file: Path,
    progress_cb=None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> dict:
    """Segment fetch + ffmpeg concat path (one httpx client / trust_env mode)."""
    settings = get_settings()
    state_path = work_dir / "segments.json"

    text, _ = await _fetch_text(client, url, headers)
    base = url
    if _is_master(text):
        base = _pick_variant(text, url)
        text, _ = await _fetch_text(client, base, headers)
    segments, _ = _parse_media_playlist(text, base)
    clip_note = ""
    segments, clip_note = _slice_segments_by_time(segments, start_sec, end_sec)

    state: dict = {"segments": {}}
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            state = {"segments": {}}

    total = len(segments)
    missing: list[int] = []
    sem = asyncio.Semaphore(settings.hls_concurrency)

    async def one(idx: int, seg: dict) -> None:
        nonlocal missing
        seg_path = work_dir / f"seg_{idx:05d}.ts"
        prev = state.get("segments", {}).get(str(idx))
        if prev == "ok" and seg_path.is_file() and seg_path.stat().st_size > 0:
            return
        async with sem:
            ok = await _download_segment(
                client, seg, seg_path, headers, settings.hls_segment_retries
            )
        if ok:
            state.setdefault("segments", {})[str(idx)] = "ok"
        else:
            state.setdefault("segments", {})[str(idx)] = "missing"
            missing.append(idx)
        state_path.write_text(json.dumps(state), encoding="utf-8")
        if progress_cb:
            done = sum(1 for v in state["segments"].values() if v == "ok")
            await progress_cb(done, total)

    await asyncio.gather(*(one(i, s) for i, s in enumerate(segments)))

    ok_count = sum(1 for v in state.get("segments", {}).values() if v == "ok")
    miss_count = total - ok_count
    ratio = miss_count / total if total else 0
    strategy = settings.hls_partial_strategy
    partial = False
    warning = clip_note or ""

    if miss_count:
        if strategy == "strict":
            raise HlsError(
                f"Missing {miss_count}/{total} segments (strict)",
                need_client=True,
            )
        if strategy == "stop" or (
            ratio > settings.hls_max_segment_failure_ratio
            or miss_count > settings.hls_max_missing_segments
        ):
            raise HlsError(
                f"Missing {miss_count}/{total} segments (ratio {ratio:.1%}); "
                "partial download retained for resume",
                need_client=True,
            )
        partial = True
        miss_msg = f"Missing {miss_count}/{total} segments (~{ratio:.1%})"
        warning = f"{warning}; {miss_msg}".strip("; ") if warning else miss_msg

    list_path = work_dir / "concat.txt"
    lines = []
    ok_indices: list[int] = []
    for i in range(total):
        if state.get("segments", {}).get(str(i)) != "ok":
            continue
        ok_indices.append(i)
        p = work_dir / f"seg_{i:05d}.ts"
        esc = p.as_posix().replace("'", r"'\''")
        lines.append(f"file '{esc}'")
    if not lines:
        raise HlsError("No segments downloaded", need_client=True)
    list_path.write_text("\n".join(lines), encoding="utf-8")

    # Mid-stream holes (missing segs between first/last ok) → must hard-rebuild timeline
    mid_gaps = _gap_indices(ok_indices)
    has_discontinuity = any(
        bool(segments[i].get("discontinuity")) for i in ok_indices if i < len(segments)
    )
    is_clip = bool(clip_note)
    # Hard when anything can break continuous PCR/PTS
    hard_align = bool(partial or mid_gaps or has_discontinuity or is_clip)
    if mid_gaps:
        gap_msg = f"mid-gap {len(mid_gaps)} segs (idx {mid_gaps[0]}…{mid_gaps[-1]})"
        warning = f"{warning}; {gap_msg}".strip("; ") if warning else gap_msg
    if has_discontinuity:
        disc_msg = "playlist DISCONTINUITY"
        warning = f"{warning}; {disc_msg}".strip("; ") if warning else disc_msg

    out_file.parent.mkdir(parents=True, exist_ok=True)
    result_out = out_file
    # Prefer concat demuxer with regenerated PTS; copy first (fast), align step fixes A/V
    cmd = [
        "ffmpeg",
        "-y",
        "-fflags",
        "+genpts+igndts+discardcorrupt",
        "-err_detect",
        "ignore_err",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        # Help AAC-in-TS → MP4 when copy succeeds
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero",
        str(out_file),
    ]
    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0 or not out_file.is_file():
        # retry concat without bitstream filter
        cmd_plain = [
            "ffmpeg",
            "-y",
            "-fflags",
            "+genpts+igndts+discardcorrupt",
            "-err_detect",
            "ignore_err",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(out_file),
        ]
        if out_file.is_file():
            try:
                out_file.unlink()
            except OSError:
                pass
        proc2 = await asyncio.to_thread(
            subprocess.run,
            cmd_plain,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc2.returncode != 0 or not out_file.is_file():
            ts_out = out_file.with_suffix(".ts")
            with ts_out.open("wb") as out:
                for i in range(total):
                    if state.get("segments", {}).get(str(i)) != "ok":
                        continue
                    p = work_dir / f"seg_{i:05d}.ts"
                    out.write(p.read_bytes())
            if ts_out.is_file() and ts_out.stat().st_size > 0:
                result_out = ts_out
            else:
                raise HlsError(
                    f"ffmpeg merge failed: {(proc2.stderr or proc.stderr or '')[-500:]}",
                    need_client=True,
                )

    # Always re-time A/V after HLS concat. Probe alone false-cleans mid-stream drift;
    # hard path rebuilds H.264+AAC when gaps / DISCONTINUITY / clip / partial.
    result_out, av_report = await asyncio.to_thread(
        align_av_timeline,
        result_out,
        force=True,
        hard=hard_align,
    )
    av_report["hls"] = {
        "partial": partial,
        "mid_gaps": mid_gaps[:40],
        "mid_gap_count": len(mid_gaps),
        "discontinuity": has_discontinuity,
        "clip": is_clip,
        "hard": hard_align,
        "segments_total": total,
        "segments_ok": ok_count,
    }
    av_warn = format_av_align_warning(av_report)
    if av_warn:
        warning = f"{warning}; {av_warn}".strip("; ") if warning else av_warn
    # Always persist probe for post-mortem (user-visible desync often has probe ok)
    _write_av_timeline_json(work_dir / "av_timeline.json", av_report)

    return {
        "partial": partial,
        "warning": warning,
        "missing": missing,
        "segments_total": total,
        "segments_done": ok_count,
        "out_file": result_out,
        "av_timeline": av_report,
    }


async def _download_hls_ffmpeg_direct(
    url: str,
    headers: dict[str, str],
    out_file: Path,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> dict:
    """
    Fallback: let ffmpeg pull the m3u8 (uses process env proxies if set).
    Supports optional wall-clock clip via -ss / -t.
    """
    if not ffmpeg_available():
        raise HlsError("ffmpeg not found for m3u8 fallback", need_client=True)

    settings = get_settings()
    hdr_lines: list[str] = []
    has_ua = any(k.lower() == "user-agent" for k in headers)
    for k, v in headers.items():
        if v is None:
            continue
        hdr_lines.append(f"{k}: {v}")
    if not has_ua:
        hdr_lines.append(f"User-Agent: {settings.user_agent}")
    # trailing blank line required by ffmpeg -headers
    header_blob = "\r\n".join(hdr_lines) + "\r\n"

    out_file.parent.mkdir(parents=True, exist_ok=True)
    s0 = max(0.0, float(start_sec or 0.0))
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if header_blob.strip():
        cmd += ["-headers", header_blob]
    if s0 > 0:
        cmd += ["-ss", f"{s0:.3f}"]
    cmd += ["-i", url]
    if end_sec is not None and float(end_sec) > s0:
        cmd += ["-t", f"{float(end_sec) - s0:.3f}"]
    # remux to mp4; aac_adtstoasc helps TS→MP4 audio
    cmd += ["-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", str(out_file)]

    logger.info("hls ffmpeg-direct fallback: %s", url[:120])
    env = proxy_env_for_subprocess(settings)
    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=max(600, int(settings.hls_max_duration_min * 60)),
        env=env,
    )
    if proc.returncode != 0 or not out_file.is_file() or out_file.stat().st_size < 64:
        # retry without bitstream filter (some streams)
        cmd2 = [c for c in cmd if c not in ("-bsf:a", "aac_adtstoasc")]
        if out_file.is_file():
            try:
                out_file.unlink()
            except OSError:
                pass
        proc2 = await asyncio.to_thread(
            subprocess.run,
            cmd2,
            capture_output=True,
            text=True,
            timeout=max(600, int(settings.hls_max_duration_min * 60)),
            env=env,
        )
        if proc2.returncode != 0 or not out_file.is_file() or out_file.stat().st_size < 64:
            err = (proc2.stderr or proc.stderr or "")[-500:]
            raise HlsError(f"ffmpeg m3u8 download failed: {err}", need_client=True)

    note = "ffmpeg-direct"
    is_clip = s0 > 0 or (end_sec is not None and float(end_sec) > 0)
    if is_clip:
        note = f"ffmpeg-direct clip {s0:.1f}s–{end_sec or 'end'}"

    # Always force align; clips use hard rebuild (input-ss often leaves A/V phase offset)
    out_file, av_report = await asyncio.to_thread(
        align_av_timeline, out_file, force=True, hard=is_clip
    )
    av_report["hls"] = {
        "mode": "ffmpeg-direct",
        "clip": is_clip,
        "hard": is_clip,
    }
    av_warn = format_av_align_warning(av_report)
    if av_warn:
        note = f"{note}; {av_warn}"
    _write_av_timeline_json(out_file.parent / "av_timeline.json", av_report)

    return {
        "partial": False,
        "warning": note,
        "missing": [],
        "segments_total": 0,
        "segments_done": 0,
        "out_file": out_file,
        "av_timeline": av_report,
    }


async def download_hls(
    url: str,
    headers: dict[str, str],
    work_dir: Path,
    out_file: Path,
    progress_cb=None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> dict:
    """
    Download HLS to out_file (mp4 via ffmpeg copy when possible).
    Optional start_sec/end_sec clip the media playlist by wall-clock time.
    Tries httpx with/without system proxy, then ffmpeg-direct fallback.
    Returns meta: partial, warning, missing, segments_total, segments_done
    """
    settings = get_settings()
    work_dir.mkdir(parents=True, exist_ok=True)

    if not ffmpeg_available():
        raise HlsError("ffmpeg not found; cannot merge m3u8", need_client=True)

    connect_errors: list[str] = []
    modes = list(iter_http_modes(settings))
    logger.info("hls download modes: %s", " → ".join(m.name for m in modes))

    for mode in modes:
        try:
            async with httpx.AsyncClient(**mode.client_kwargs(settings)) as client:
                meta = await _download_hls_segments(
                    client,
                    url,
                    headers,
                    work_dir,
                    out_file,
                    progress_cb=progress_cb,
                    start_sec=start_sec,
                    end_sec=end_sec,
                )
                if mode.proxy or mode.name != "direct":
                    w = meta.get("warning") or ""
                    tag = f"via {mode.name}"
                    meta["warning"] = f"{w}; {tag}".strip("; ") if w else tag
                return meta
        except httpx.RequestError as e:
            msg = f"{mode.name}: {type(e).__name__}: {e}"
            connect_errors.append(msg)
            logger.warning("hls playlist/segments connect failed (%s)", msg)
            continue
        except HlsError:
            raise

    # All httpx modes failed → ffmpeg (inherits proxy env we inject)
    try:
        meta = await _download_hls_ffmpeg_direct(
            url, headers, out_file, start_sec=start_sec, end_sec=end_sec
        )
        if connect_errors:
            prev = connect_errors[-1]
            meta["warning"] = f"{meta.get('warning') or ''}; after httpx: {prev}".strip("; ")
        return meta
    except HlsError as fe:
        detail = "; ".join(connect_errors) or "unknown"
        raise HlsError(
            f"m3u8 connect failed ({detail}); ffmpeg fallback: {fe}",
            need_client=True,
        ) from fe
