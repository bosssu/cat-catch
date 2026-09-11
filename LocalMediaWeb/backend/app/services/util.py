from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse, unquote

SAFE_CATEGORY_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,64}$")


def trust_env_attempts(prefer: bool = True) -> list[bool]:
    """
    Ordered trust_env flags for httpx: preferred first, then the opposite once.
    Prefer True so system proxies (common for adult/foreign CDNs) are tried first.
    """
    first = bool(prefer)
    second = not first
    return [first, second]


def safe_category(name: str | None) -> str:
    name = (name or "default").strip() or "default"
    if name in (".", "..") or "/" in name or "\\" in name:
        return "default"
    if not SAFE_CATEGORY_RE.match(name):
        # soften invalid names
        cleaned = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", name, flags=re.UNICODE)[:64]
        return cleaned or "default"
    return name


def url_hash(url: str, category: str = "") -> str:
    raw = f"{category}|{url.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_clip_bounds(
    start_sec: float | None,
    end_sec: float | None,
) -> tuple[float | None, float | None]:
    """
    Normalize clip times. Full playlist (no clip) → (None, None).
    start=0 with no end is treated as full (same as omitting range).
    """
    try:
        s = float(start_sec) if start_sec is not None and start_sec != "" else None
    except (TypeError, ValueError):
        s = None
    try:
        e = float(end_sec) if end_sec is not None and end_sec != "" else None
    except (TypeError, ValueError):
        e = None
    if e is not None and e <= 0:
        e = None
    if s is not None and s < 0:
        s = 0.0
    # no meaningful clip
    if (s is None or s <= 0) and e is None:
        return None, None
    if s is None:
        s = 0.0
    return s, e


def clip_disambiguator(start_sec: float | None, end_sec: float | None) -> str:
    """Stable short tag for filenames / hashes, e.g. t=570-650 or t=1080-end."""
    s, e = normalize_clip_bounds(start_sec, end_sec)
    if s is None and e is None:
        return ""
    s_i = int(round(s or 0))
    e_part = "end" if e is None else str(int(round(e)))
    return f"t={s_i}-{e_part}"


def media_url_hash(
    url: str,
    category: str = "",
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> str:
    """
    Dedup key for ingest. Different clip ranges of the same m3u8 are distinct.
    Times are rounded to whole seconds so 570 and 570.0 match.
    """
    tag = clip_disambiguator(start_sec, end_sec)
    if tag:
        return url_hash(f"{url}|{tag}", category)
    return url_hash(url, category)


def content_hash_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# Douyin / generic live or unbounded progressive streams (no finite VOD file).
_LIVE_HOST_RE = re.compile(
    r"(^|\.)("
    r"pull[-.].*douyincdn\.com|"
    r".*live.*douyincdn\.com|"
    r"live\.douyin\.com|"
    r"pull-flv[^.]*\.|"
    r"pull-hls[^.]*\.|"
    r"push-.*douyincdn\.com|"
    r"webcast\..*"
    r")",
    re.I,
)
_LIVE_PATH_RE = re.compile(
    r"("
    r"/thirdgame/stream-|"
    r"/stream-\d|"
    r"/webcast/|"
    r"/live/stream|"
    r"/liveplay|"
    r"/flv/live|"
    r"rtm_expr_tag=|"
    r"major_anchor|"
    r"biz_protocol=flv"
    r")",
    re.I,
)


def live_stream_reject_reason(url: str, content_type: str | None = None) -> str | None:
    """
    Return a short reason if URL looks like a live / unbounded stream
    (Douyin pull-FLV, RTMP, etc.). VOD m3u8/mp4 should return None.
    """
    u = (url or "").strip()
    if not u:
        return None
    low = u.lower()
    if low.startswith("rtmp://") or low.startswith("rtmps://") or low.startswith("srt://"):
        return "live protocol (rtmp/srt)"
    try:
        p = urlparse(u)
    except Exception:
        return None
    host = (p.hostname or "").lower()
    path = (p.path or "").lower()
    query = (p.query or "").lower()
    path_q = f"{path}?{query}"

    # Explicit live CDN hosts (Douyin pull edge)
    if host and _LIVE_HOST_RE.search(host):
        return f"live CDN host ({host})"
    if "douyincdn.com" in host and (
        host.startswith("pull-") or ".pull" in host or "pull." in host
    ):
        return f"Douyin pull CDN ({host})"
    if host.endswith("douyincdn.com") and path.endswith(".flv"):
        return "Douyin CDN FLV (likely live)"

    if _LIVE_PATH_RE.search(path_q) or _LIVE_PATH_RE.search(low):
        # Allow normal VOD mp4 on same query noise? major_anchor is live-only.
        if path.endswith((".m3u8", ".mpd", ".mp4", ".webm", ".mov", ".mkv")):
            # finite playlist/file extensions usually VOD
            if "biz_protocol=flv" in query or "/thirdgame/stream-" in path:
                return "live stream path markers"
            return None
        return "live stream path markers"

    # Bare .flv on streaming-style hosts without VOD path
    if path.endswith(".flv"):
        if any(
            x in host
            for x in (
                "live",
                "pull",
                "push",
                "flv",
                "douyin",
                "tiktok",
                "byte",
                "webcast",
            )
        ):
            return "FLV on streaming host (likely live)"

    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in ("video/x-flv", "video/flv") and (
        "live" in host or "pull" in host or path.endswith(".flv")
    ):
        return f"FLV content-type ({ct})"
    return None


def is_likely_live_stream(url: str, content_type: str | None = None) -> bool:
    return live_stream_reject_reason(url, content_type) is not None


def safe_filename(title: str, url: str, ext: str, *, disambiguator: str = "") -> str:
    """
    Build a filesystem-safe name. ``disambiguator`` (e.g. m3u8 clip range
    ``t=570-650``) is folded into the short hash so same URL + different clips
    do not collide on rel_path / overwrite each other.
    """
    base = title or Path(unquote(urlparse(url).path)).stem or "media"
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", base).strip(" .")[:80] or "media"
    key = f"{url}|{disambiguator}" if disambiguator else url
    short = hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]
    ext = ext.lstrip(".") or "bin"
    # Optional human-readable clip tag in the name (still hashed for uniqueness)
    tag = ""
    if disambiguator:
        tag_raw = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", disambiguator).strip(" .")[:32]
        if tag_raw:
            tag = f"_{tag_raw}"
    return f"{base}{tag}_{short}.{ext}"


def ensure_unique_path(dest: Path) -> Path:
    """If dest already exists, append _1, _2, ... before the extension."""
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    parent = dest.parent
    for i in range(1, 10000):
        cand = parent / f"{stem}_{i}{suffix}"
        if not cand.exists():
            return cand
    raise OSError(f"Could not find unique path for {dest}")


def guess_ext(url: str, content_type: str | None, media_type: str) -> str:
    path = urlparse(url).path.lower()
    for e in (
        ".m3u8",
        ".mp4",
        ".webm",
        ".mkv",
        ".mov",
        ".ts",
        ".m4s",
        ".gif",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".avif",
        ".bmp",
    ):
        if path.endswith(e):
            return e.lstrip(".")
    ct = (content_type or "").split(";")[0].strip().lower()
    mapping = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/avif": "avif",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "video/quicktime": "mov",
        "application/vnd.apple.mpegurl": "m3u8",
        "application/x-mpegurl": "m3u8",
    }
    if ct in mapping:
        return mapping[ct]
    if media_type == "gif":
        return "gif"
    if media_type == "image":
        return "jpg"
    if media_type in ("m3u8", "dash"):
        return "mp4"
    if media_type == "video":
        return "mp4"
    return "bin"


_AUDIO_EXTS = (
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".wav",
    ".ogg",
    ".opus",
    ".wma",
    ".aiff",
    ".aif",
    ".oga",
)


def detect_media_type(url: str, content_type: str | None, hinted: str | None) -> str:
    u = (url or "").lower()
    ct = (content_type or "").lower()
    # URL extension always wins over wrong client hints (Steam DASH was mislabeled m3u8)
    path = u.split("?")[0]
    if path.endswith(".mpd") or "dash+xml" in ct or "/dash_" in path:
        return "dash"
    if path.endswith(".m3u8") or "mpegurl" in ct:
        return "m3u8"
    if hinted and hinted in ("image", "gif", "video", "audio", "m3u8", "dash"):
        if hinted != "video":
            return hinted
    if "image/gif" in ct or path.endswith(".gif"):
        return "gif"
    if ct.startswith("image/") or any(
        path.endswith(e) for e in (".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp")
    ):
        return "image"
    if ct.startswith("audio/") or any(path.endswith(e) for e in _AUDIO_EXTS):
        return "audio"
    return "video"


def headers_from_json(raw: str | None) -> dict[str, str]:
    """Extract HTTP headers from job payload JSON (flat or {headers, start_sec, end_sec})."""
    headers, _, _ = parse_job_payload(raw)
    return headers


def parse_job_payload(raw: str | None) -> tuple[dict[str, str], float | None, float | None]:
    """
    Returns (headers, start_sec, end_sec).
    New format: {"headers": {...}, "start_sec": 0, "end_sec": 120}
    Legacy: flat header map only.
    """
    if not raw:
        return {}, None, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}, None, None
    if not isinstance(data, dict):
        return {}, None, None

    start = data.get("start_sec")
    end = data.get("end_sec")
    start_sec: float | None
    end_sec: float | None
    try:
        start_sec = float(start) if start is not None and start != "" else None
    except (TypeError, ValueError):
        start_sec = None
    try:
        end_sec = float(end) if end is not None and end != "" else None
    except (TypeError, ValueError):
        end_sec = None

    if isinstance(data.get("headers"), dict):
        hdrs = {str(k): str(v) for k, v in data["headers"].items() if v is not None}
        return hdrs, start_sec, end_sec
    # legacy flat headers (ignore non-string meta keys if any)
    skip = {"start_sec", "end_sec", "headers"}
    hdrs = {
        str(k): str(v)
        for k, v in data.items()
        if v is not None and k not in skip and not str(k).startswith("__")
    }
    return hdrs, start_sec, end_sec


def job_payload_json(
    headers: dict[str, str],
    start_sec: float | None = None,
    end_sec: float | None = None,
    allow_ios_incompatible: bool = False,
) -> str:
    payload: dict = {"headers": headers or {}}
    if start_sec is not None:
        payload["start_sec"] = float(start_sec)
    if end_sec is not None:
        payload["end_sec"] = float(end_sec)
    if allow_ios_incompatible:
        payload["allow_ios_incompatible"] = True
    return json.dumps(payload, ensure_ascii=False)


def job_allows_ios_incompatible(raw: str | None) -> bool:
    if not raw:
        return False
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return False
    if not isinstance(data, dict):
        return False
    return bool(data.get("allow_ios_incompatible"))


def is_probably_html(content_type: str | None, sample: bytes) -> bool:
    ct = (content_type or "").lower()
    if "text/html" in ct:
        return True
    head = sample[:200].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")
