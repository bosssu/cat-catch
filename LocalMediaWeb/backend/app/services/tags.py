"""Media tags: normalize, suggest (rule-based), serialize."""

from __future__ import annotations

import json
import math
import re
from urllib.parse import urlparse

MAX_TAGS = 5
TAG_RE = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff\-+.#]{0,31}$", re.UNICODE)

# Common host → short tag
HOST_TAGS = {
    "bilibili.com": "bilibili",
    "b23.tv": "bilibili",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "twitter.com": "twitter",
    "x.com": "twitter",
    "instagram.com": "instagram",
    "tiktok.com": "tiktok",
    "douyin.com": "douyin",
    "weibo.com": "weibo",
    "github.com": "github",
    "reddit.com": "reddit",
    "vimeo.com": "vimeo",
    "twitch.tv": "twitch",
    "pornhub.com": "video",
    "xvideos.com": "video",
    "xhcdn.com": "video",
    "googlevideo.com": "youtube",
    "ytimg.com": "youtube",
    "pinimg.com": "pinterest",
    "pinterest.com": "pinterest",
}

EXT_TAGS = {
    "mp4": "mp4",
    "webm": "webm",
    "mkv": "mkv",
    "mov": "mov",
    "m3u8": "m3u8",
    "mpd": "dash",
    "gif": "gif",
    "png": "png",
    "jpg": "jpg",
    "jpeg": "jpg",
    "webp": "webp",
    "avif": "avif",
}

STOP_WORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "http",
    "https",
    "www",
    "com",
    "www",
    "video",
    "image",
    "media",
    "page",
    "watch",
    "index",
    "html",
    "的",
    "了",
    "和",
    "是",
    "在",
    "我",
    "有",
    "不",
}

# Format / site / media-type tags: common but weak for "similar content".
WEAK_TAGS = frozenset(
    {
        "video",
        "image",
        "gif",
        "audio",
        "mp4",
        "webm",
        "mkv",
        "mov",
        "m3u8",
        "dash",
        "png",
        "jpg",
        "jpeg",
        "webp",
        "avif",
        "bilibili",
        "youtube",
        "twitter",
        "instagram",
        "tiktok",
        "douyin",
        "weibo",
        "github",
        "reddit",
        "vimeo",
        "twitch",
        "pinterest",
    }
)

# Normalize near-synonyms before store / compare.
TAG_ALIASES = {
    "yt": "youtube",
    "youtu": "youtube",
    "bili": "bilibili",
    "bilibili.com": "bilibili",
    "x": "twitter",
    "二次元": "anime",
    "动漫": "anime",
    "动画": "anime",
    "漫画": "manga",
    "插画": "illustration",
    "美图": "photo",
    "照片": "photo",
    "图片": "image",
    "影片": "video",
    "视频": "video",
}


def canonical_tag(name: str) -> str:
    n = (name or "").strip().lower().lstrip("#")
    n = re.sub(r"\s+", "-", n)
    return TAG_ALIASES.get(n, n)


def is_weak_tag(name: str) -> bool:
    return canonical_tag(name) in WEAK_TAGS


def normalize_tags(raw) -> list[str]:
    """Dedupe, trim, validate; at most MAX_TAGS."""
    if raw is None:
        return []
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list):
                raw = parsed
            else:
                raw = re.split(r"[,，;；\s]+", s)
        except json.JSONDecodeError:
            raw = re.split(r"[,，;；\s]+", s)
    if not isinstance(raw, (list, tuple, set)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for t in raw:
        if t is None:
            continue
        name = canonical_tag(str(t))
        if not name or name in seen:
            continue
        if not TAG_RE.match(name):
            name = re.sub(r"[^\w\u4e00-\u9fff\-+.#]+", "", name, flags=re.UNICODE)[:32]
            name = canonical_tag(name)
        if not name or not TAG_RE.match(name) or name in seen:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_TAGS:
            break
    return out


def tags_to_json(tags) -> str:
    return json.dumps(normalize_tags(tags), ensure_ascii=False)


def tags_from_json(s: str | None) -> list[str]:
    if not s:
        return []
    try:
        data = json.loads(s)
        return normalize_tags(data)
    except (json.JSONDecodeError, TypeError):
        return normalize_tags(s)


def _host_tag(url: str) -> str | None:
    if not url:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return None
    if host.startswith("www."):
        host = host[4:]
    for suffix, tag in HOST_TAGS.items():
        if host == suffix or host.endswith("." + suffix):
            return tag
    # generic: first label if meaningful
    parts = host.split(".")
    if len(parts) >= 2:
        label = parts[-2] if parts[-1] in ("com", "net", "org", "tv", "io", "co") else parts[0]
        label = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", label)
        if 2 <= len(label) <= 16 and label not in STOP_WORDS:
            return label
    return None


def _ext_tag(url: str) -> str | None:
    if not url:
        return None
    path = url.split("?")[0].split("#")[0]
    if "." not in path:
        return None
    ext = path.rsplit(".", 1)[-1].lower()
    return EXT_TAGS.get(ext)


def title_tokens(title: str, *, limit: int = 8) -> list[str]:
    """CJK chunks 2–6 chars + latin words; for suggest + similar rank."""
    if not title:
        return []
    tokens: list[str] = []
    seen: set[str] = set()
    for m in re.finditer(r"[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,20}", title):
        t = canonical_tag(m.group(0))
        if not t or t in STOP_WORDS or t in seen or is_weak_tag(t):
            continue
        seen.add(t)
        tokens.append(t)
        if len(tokens) >= limit:
            break
    return tokens


def _title_tokens(title: str) -> list[str]:
    return title_tokens(title, limit=4)


def url_host(url: str) -> str:
    """Registrable-ish host label for same-source checks."""
    if not url:
        return ""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


def tag_idf_weights(tag_lists: list[list[str]]) -> dict[str, float]:
    """IDF over a media corpus; rare tags weigh more for similarity."""
    n = max(1, len(tag_lists))
    df: dict[str, int] = {}
    for tags in tag_lists:
        for t in set(tags or []):
            df[t] = df.get(t, 0) + 1
    out: dict[str, float] = {}
    for t, c in df.items():
        idf = math.log(1.0 + n / (1.0 + c))
        # Format/site tags stay low even if rare in a tiny library
        if t in WEAK_TAGS:
            idf *= 0.12
        out[t] = max(0.05, idf)
    return out


def weighted_jaccard(
    a: list[str],
    b: list[str],
    weights: dict[str, float] | None = None,
) -> float:
    sa, sb = set(a or []), set(b or [])
    if not sa or not sb:
        return 0.0
    w = weights or {}
    inter = sa & sb
    union = sa | sb
    wi = sum(w.get(t, 1.0) for t in inter)
    wu = sum(w.get(t, 1.0) for t in union)
    if wu <= 0:
        return 0.0
    return wi / wu


def strong_tags(tags: list[str] | None) -> list[str]:
    return [t for t in (tags or []) if t and t not in WEAK_TAGS]


def title_overlap(a: str, b: str) -> float:
    """Jaccard on title tokens; 0 if either side empty."""
    ta, tb = set(title_tokens(a)), set(title_tokens(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def jaccard(a: list[str], b: list[str]) -> float:
    sa, sb = set(a or []), set(b or [])
    if not sa and not sb:
        return 0.0
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def suggest_tags(
    *,
    title: str = "",
    url: str = "",
    media_type: str = "",
    source_page: str = "",
    existing_pool: list[str] | None = None,
    limit: int = MAX_TAGS,
) -> list[str]:
    """
    Rule-based tag suggestions for ingest dialog / API.

    Prefer title / pool hits (semantic); put format & site tags last so they
    are less likely to fill the 5 slots when the dialog auto-picks.
    """
    strong: list[str] = []
    weak: list[str] = []

    for tok in _title_tokens(title or ""):
        strong.append(tok)

    blob = f"{title} {url} {source_page}".lower()
    for p in existing_pool or []:
        p = canonical_tag(str(p or ""))
        if p and p in blob:
            (weak if p in WEAK_TAGS else strong).append(p)

    mt = (media_type or "").lower().strip()
    if mt in ("video", "image", "gif", "m3u8", "dash", "audio"):
        if mt == "audio":
            weak.append("video")
        else:
            weak.append(mt if mt != "dash" else "dash")

    et = _ext_tag(url) or _ext_tag(source_page)
    if et:
        weak.append(et)

    for u in (url, source_page):
        ht = _host_tag(u)
        if ht:
            weak.append(ht)
            break

    # Strong first so normalize_tags keeps semantic tags under MAX_TAGS.
    return normalize_tags(strong + weak)[: max(1, min(limit, MAX_TAGS))]
