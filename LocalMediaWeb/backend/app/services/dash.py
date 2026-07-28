"""Minimal MPEG-DASH (MPD) downloader for Steam-style SegmentTemplate VoD."""

from __future__ import annotations

import asyncio
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

from app.core.config import ffmpeg_available, get_settings
from app.services.util import is_probably_html

_NS = {"mpd": "urn:mpeg:dash:schema:mpd:2011"}


class DashError(Exception):
    def __init__(self, message: str, http_status: int = 0, need_client: bool = False):
        super().__init__(message)
        self.http_status = http_status
        self.need_client = need_client


def _local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _parse_duration_sec(s: str | None) -> float:
    """Parse ISO-8601 duration like PT2M44.3S / PT164.3S."""
    if not s:
        return 0.0
    s = s.strip()
    m = re.fullmatch(
        r"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?",
        s,
        re.I,
    )
    if not m:
        return 0.0
    h = float(m.group(1) or 0)
    mi = float(m.group(2) or 0)
    sec = float(m.group(3) or 0)
    return h * 3600 + mi * 60 + sec


def _subst_template(tpl: str, *, rep_id: str, number: int | None = None, bandwidth: int | None = None) -> str:
    """Expand DASH $RepresentationID$ / $Number%05d$ / $Bandwidth$ tokens."""
    out = tpl.replace("$$", "\x00")  # escape literal $
    out = out.replace("$RepresentationID$", str(rep_id))
    if bandwidth is not None:
        out = out.replace("$Bandwidth$", str(bandwidth))

    def num_repl(m: re.Match[str]) -> str:
        if number is None:
            return m.group(0)
        width = m.group(1)
        if width:
            return str(number).zfill(int(width))
        return str(number)

    out = re.sub(r"\$Number(?:%0(\d+)d)?\$", num_repl, out)
    out = out.replace("\x00", "$")
    return out


def _find_segment_template(rep_el: ET.Element) -> ET.Element | None:
    for child in rep_el:
        if _local(child.tag) == "SegmentTemplate":
            return child
    # sometimes on AdaptationSet
    parent = None  # filled by caller if needed
    return None


def _adaptation_set_of(rep_el: ET.Element, root: ET.Element) -> ET.Element | None:
    for period in root:
        if _local(period.tag) != "Period":
            continue
        for aset in period:
            if _local(aset.tag) != "AdaptationSet":
                continue
            for rep in aset:
                if rep is rep_el:
                    return aset
    return None


def _collect_reps(root: ET.Element) -> list[dict]:
    out: list[dict] = []
    for period in root:
        if _local(period.tag) != "Period":
            continue
        for aset in period:
            if _local(aset.tag) != "AdaptationSet":
                continue
            content_type = (aset.attrib.get("contentType") or "").lower()
            mime_as = (aset.attrib.get("mimeType") or "").lower()
            st_as = None
            for ch in aset:
                if _local(ch.tag) == "SegmentTemplate":
                    st_as = ch
                    break
            for rep in aset:
                if _local(rep.tag) != "Representation":
                    continue
                mime = (rep.attrib.get("mimeType") or mime_as or "").lower()
                codecs = (rep.attrib.get("codecs") or "").lower()
                rid = rep.attrib.get("id") or ""
                bw = int(rep.attrib.get("bandwidth") or 0)
                w = int(rep.attrib.get("width") or 0)
                h = int(rep.attrib.get("height") or 0)
                st = None
                for ch in rep:
                    if _local(ch.tag) == "SegmentTemplate":
                        st = ch
                        break
                # NOTE: empty ET.Element is falsy — never use `st or st_as`
                if st is None:
                    st = st_as
                kind = "video"
                if content_type == "audio" or mime.startswith("audio/") or codecs.startswith("mp4a"):
                    kind = "audio"
                elif "thumb" in rid.lower() or "image" in mime:
                    kind = "other"
                elif content_type == "video" or mime.startswith("video/") or w or h:
                    kind = "video"
                elif mime.startswith("audio/"):
                    kind = "audio"
                out.append(
                    {
                        "id": rid,
                        "bandwidth": bw,
                        "width": w,
                        "height": h,
                        "mime": mime,
                        "codecs": codecs,
                        "kind": kind,
                        "template": st,
                        "aset": aset,
                    }
                )
    return out


def _segment_urls(
    *,
    base_url: str,
    st: ET.Element,
    rep_id: str,
    bandwidth: int,
    total_duration_sec: float,
) -> tuple[str | None, list[str]]:
    init_tpl = st.attrib.get("initialization") or st.attrib.get("Initialization") or ""
    media_tpl = st.attrib.get("media") or ""
    timescale = int(st.attrib.get("timescale") or 1)
    start_number = int(st.attrib.get("startNumber") or 1)
    duration = int(st.attrib.get("duration") or 0)

    init_url = None
    if init_tpl:
        init_url = urljoin(base_url, _subst_template(init_tpl, rep_id=rep_id, bandwidth=bandwidth))

    # SegmentTimeline if present
    timeline = None
    for ch in st:
        if _local(ch.tag) == "SegmentTimeline":
            timeline = ch
            break

    media_urls: list[str] = []
    if timeline is not None:
        num = start_number
        for s_el in timeline:
            if _local(s_el.tag) != "S":
                continue
            d = int(s_el.attrib.get("d") or 0)
            r = int(s_el.attrib.get("r") or 0)
            # r is repeat count (extra), so total = r+1
            count = r + 1
            for _ in range(count):
                media_urls.append(
                    urljoin(
                        base_url,
                        _subst_template(media_tpl, rep_id=rep_id, number=num, bandwidth=bandwidth),
                    )
                )
                num += 1
                if d:
                    pass
        return init_url, media_urls

    if not media_tpl or duration <= 0 or timescale <= 0:
        raise DashError("MPD SegmentTemplate missing media/duration")

    seg_sec = duration / timescale
    if seg_sec <= 0:
        raise DashError("Invalid segment duration")
    # +1 margin for rounding (Steam trailers often need last partial)
    n = max(1, int(math.ceil(total_duration_sec / seg_sec)) + 1)
    # hard cap to avoid runaway
    n = min(n, 20000)
    for i in range(n):
        num = start_number + i
        media_urls.append(
            urljoin(
                base_url,
                _subst_template(media_tpl, rep_id=rep_id, number=num, bandwidth=bandwidth),
            )
        )
    return init_url, media_urls


async def _fetch_bytes(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    retries: int = 3,
) -> tuple[bytes, int]:
    last_status = 0
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            r = await client.get(url, headers=headers, follow_redirects=True)
            last_status = r.status_code
            if r.status_code in (401, 403):
                raise DashError(f"HTTP {r.status_code}", http_status=r.status_code, need_client=True)
            if r.status_code == 404:
                return b"", 404
            if r.status_code >= 400:
                await asyncio.sleep(0.25 * (attempt + 1))
                continue
            if is_probably_html(r.headers.get("content-type"), r.content[:200]):
                raise DashError("Got HTML instead of media segment", http_status=r.status_code, need_client=True)
            return r.content, r.status_code
        except DashError:
            raise
        except Exception as e:
            last_err = e
            await asyncio.sleep(0.25 * (attempt + 1))
    if last_err:
        raise DashError(f"Segment fetch failed: {last_err}", need_client=True)
    return b"", last_status


async def _download_track(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    rep: dict,
    total_duration_sec: float,
    headers: dict[str, str],
    dest: Path,
    progress_cb=None,
    label: str = "",
) -> dict:
    st = rep.get("template")
    if st is None:
        raise DashError(f"No SegmentTemplate for representation {rep.get('id')}")
    init_url, media_urls = _segment_urls(
        base_url=base_url,
        st=st,
        rep_id=str(rep["id"]),
        bandwidth=int(rep.get("bandwidth") or 0),
        total_duration_sec=total_duration_sec,
    )
    parts: list[bytes] = []
    if init_url:
        data, status = await _fetch_bytes(client, init_url, headers)
        if status == 404 or not data:
            raise DashError(f"Init segment missing ({status}): {init_url}", http_status=status)
        parts.append(data)

    settings = get_settings()
    conc = max(1, min(int(getattr(settings, "hls_concurrency", 8) or 8), 16))
    sem = asyncio.Semaphore(conc)
    results: list[bytes | None] = [None] * len(media_urls)
    done_box = {"n": 0}

    async def one(i: int, u: str) -> None:
        async with sem:
            data, status = await _fetch_bytes(client, u, headers)
        if status == 404 or not data:
            results[i] = None
            return
        results[i] = data
        done_box["n"] += 1
        if progress_cb:
            await progress_cb(label, done_box["n"], len(media_urls))

    await asyncio.gather(*(one(i, u) for i, u in enumerate(media_urls)))

    # trim trailing 404s (over-estimated segment count) but keep gaps as missing
    while results and results[-1] is None:
        results.pop()

    missing = sum(1 for x in results if x is None)
    body_parts = [x for x in results if x]
    if not body_parts:
        raise DashError("No media segments downloaded", need_client=True)
    if results and results[0] is None:
        raise DashError(f"First media segment 404: {media_urls[0]}", http_status=404)

    parts.extend(body_parts)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"".join(parts))
    return {
        "segments_done": len(body_parts),
        "segments_missing": missing,
        "path": dest,
        "size": dest.stat().st_size,
    }


async def _ffmpeg_mux(video: Path, audio: Path | None, out: Path) -> Path:
    if not ffmpeg_available():
        # keep fmp4 video only
        if out != video:
            out.write_bytes(video.read_bytes())
        return out
    import subprocess

    out.parent.mkdir(parents=True, exist_ok=True)
    if audio and audio.is_file() and audio.stat().st_size > 0:
        cmd = [
            "ffmpeg",
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
            "1:a:0",
            "-shortest",
            str(out),
        ]
    else:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-c",
            "copy",
            str(out),
        ]
    proc = await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode == 0 and out.is_file() and out.stat().st_size > 0:
        return out
    # fallback: raw video fmp4 is still playable in many players
    if video.is_file() and video.stat().st_size > 0:
        if out != video:
            out.write_bytes(video.read_bytes())
        return out
    raise DashError(
        f"ffmpeg mux failed: {(proc.stderr or '')[-500:]}",
        need_client=True,
    )


async def download_dash(
    url: str,
    headers: dict[str, str],
    work_dir: Path,
    out_file: Path,
    progress_cb=None,
) -> dict:
    """
    Download a static DASH MPD (Steam trailers) into out_file (mp4).
    Picks highest-bandwidth video + audio representations.
    """
    settings = get_settings()
    work_dir.mkdir(parents=True, exist_ok=True)
    timeout = httpx.Timeout(max(60.0, float(settings.request_timeout_sec or 60)))
    from app.services.http_client import HttpMode, iter_http_modes

    text = ""
    working_mode: HttpMode | None = None
    last_req_err: Exception | None = None
    for mode in iter_http_modes(settings):
        try:
            async with httpx.AsyncClient(**mode.client_kwargs(settings, timeout=timeout)) as probe:
                r = await probe.get(url, headers=headers)
                if r.status_code in (401, 403):
                    raise DashError(
                        f"MPD HTTP {r.status_code}",
                        http_status=r.status_code,
                        need_client=True,
                    )
                if r.status_code >= 400:
                    raise DashError(f"MPD HTTP {r.status_code}", http_status=r.status_code)
                if is_probably_html(r.headers.get("content-type"), r.content[:200]):
                    raise DashError(
                        "MPD URL returned HTML",
                        http_status=r.status_code,
                        need_client=True,
                    )
                text = r.text
                if "<MPD" not in text and "<mpd" not in text:
                    raise DashError("Not a DASH MPD playlist", need_client=False)
                working_mode = mode
                break
        except httpx.RequestError as e:
            last_req_err = e
            continue
    if working_mode is None:
        raise DashError(
            f"MPD connect failed: {last_req_err}",
            need_client=True,
        )

    async with httpx.AsyncClient(
        **working_mode.client_kwargs(settings, timeout=timeout)
    ) as client:
        try:
            root = ET.fromstring(text)
        except ET.ParseError as e:
            raise DashError(f"Invalid MPD XML: {e}") from e

        total_dur = _parse_duration_sec(root.attrib.get("mediaPresentationDuration"))
        if total_dur <= 0:
            total_dur = 180.0
        if total_dur > settings.hls_max_duration_min * 60:
            raise DashError(
                f"DASH duration {total_dur:.0f}s exceeds limit "
                f"{settings.hls_max_duration_min} min"
            )

        # Base URL: MPD location directory (Steam uses relative segment paths)
        base = url
        # honor optional BaseURL child
        for child in root:
            if _local(child.tag) == "BaseURL" and (child.text or "").strip():
                base = urljoin(url, child.text.strip())
                break
        if not base.endswith("/") and not base.lower().endswith(".mpd"):
            base = base + "/"
        # for .mpd URL, directory form
        if base.lower().split("?")[0].endswith(".mpd"):
            base = base.rsplit("/", 1)[0] + "/"

        reps = _collect_reps(root)
        videos = [x for x in reps if x["kind"] == "video" and x.get("template") is not None]
        audios = [x for x in reps if x["kind"] == "audio" and x.get("template") is not None]
        if not videos:
            raise DashError("No video Representation with SegmentTemplate in MPD")

        # Prefer AVC over AV1 for broader playback when bandwidth similar
        def video_key(v: dict) -> tuple:
            codecs = v.get("codecs") or ""
            av1_pen = 1 if "av01" in codecs or "av1" in codecs else 0
            return (v.get("bandwidth") or 0, v.get("width") or 0, -av1_pen)

        videos.sort(key=video_key, reverse=True)
        # If top is AV1 and an AVC exists within 70% bandwidth, prefer AVC
        best_v = videos[0]
        if "av01" in (best_v.get("codecs") or "") or "av1" in (best_v.get("codecs") or ""):
            for v in videos:
                c = v.get("codecs") or ""
                if "avc" in c or "hvc" in c or "hev" in c:
                    if (v.get("bandwidth") or 0) >= (best_v.get("bandwidth") or 0) * 0.5:
                        best_v = v
                        break

        best_a = None
        if audios:
            audios.sort(key=lambda x: x.get("bandwidth") or 0, reverse=True)
            best_a = audios[0]

        async def _prog(label: str, done: int, total: int) -> None:
            if progress_cb:
                await progress_cb(done, total)

        v_path = work_dir / "video.m4s"
        a_path = work_dir / "audio.m4s"
        v_meta = await _download_track(
            client,
            base_url=base,
            rep=best_v,
            total_duration_sec=total_dur,
            headers=headers,
            dest=v_path,
            progress_cb=_prog,
            label="video",
        )
        a_meta = None
        if best_a:
            try:
                a_meta = await _download_track(
                    client,
                    base_url=base,
                    rep=best_a,
                    total_duration_sec=total_dur,
                    headers=headers,
                    dest=a_path,
                    progress_cb=None,
                    label="audio",
                )
            except DashError:
                a_meta = None  # video-only ok

        out_file = out_file.with_suffix(".mp4")
        final = await _ffmpeg_mux(v_path, a_path if a_meta else None, out_file)
        partial = False
        warning = ""
        # if many early 404s relative to expected, mark partial
        expected = max(1, int(math.ceil(total_dur / 3.0)))
        if v_meta["segments_done"] < expected * 0.9:
            partial = True
            warning = (
                f"DASH video segments {v_meta['segments_done']} "
                f"(expected ~{expected})"
            )

        return {
            "partial": partial,
            "warning": warning,
            "missing": [],
            "segments_total": expected,
            "segments_done": v_meta["segments_done"],
            "out_file": final,
            "video_rep": best_v.get("id"),
            "bandwidth": best_v.get("bandwidth"),
        }
