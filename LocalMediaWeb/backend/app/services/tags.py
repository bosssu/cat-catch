"""Media tags: normalize, suggest (rule-based), serialize."""

from __future__ import annotations

import json
import math
import re
from urllib.parse import urlparse

# Soft cap only for auto-suggest length (not storage). Per-item tags are unlimited (deduped).
SUGGEST_DEFAULT_LIMIT = 12
TAG_RE = re.compile(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff\-+.#]{0,31}$", re.UNICODE)

# Special content flag: applied on ingest / manage toggle; filtered by feed when off.
RESTRICTED_TAG = "限制级"

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
        RESTRICTED_TAG,
    }
)


def apply_restricted_flag(tags, restricted: bool = False) -> list[str]:
    """When restricted=True, ensure RESTRICTED_TAG is present; otherwise leave tags as-is."""
    out = normalize_tags(tags)
    if restricted and RESTRICTED_TAG not in out:
        out = out + [RESTRICTED_TAG]
    return out


def set_restricted_flag(tags, restricted: bool) -> list[str]:
    """Force-add or remove RESTRICTED_TAG."""
    out = [t for t in normalize_tags(tags) if t != RESTRICTED_TAG]
    if restricted:
        out.append(RESTRICTED_TAG)
    return out


def is_restricted_tags(tags) -> bool:
    return RESTRICTED_TAG in normalize_tags(tags)


def tags_json_has_restricted(tags_json: str | None) -> bool:
    return is_restricted_tags(tags_from_json(tags_json))

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
    """Dedupe, trim, validate. No per-item count limit."""
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


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein; small strings only (tags ≤32)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    if abs(len(a) - len(b)) > 3:
        return 99
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            ins, delete, sub = cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)
            cur.append(min(ins, delete, sub))
        prev = cur
    return prev[-1]


def pool_match_score(
    tag: str,
    *,
    blob: str,
    title_toks: list[str],
    count: int = 0,
) -> float:
    """
    How well a library tag fits this media (for suggest ranking).
    Higher = better. 0 = no signal (skip unless boosted elsewhere).
    """
    t = canonical_tag(tag)
    if not t:
        return 0.0
    score = 0.0
    weak = t in WEAK_TAGS
    if t in blob:
        score += 120.0 if not weak else 40.0
    for tok in title_toks:
        if not tok:
            continue
        if t == tok:
            score += 100.0
        elif t in tok or tok in t:
            score += 55.0 if not weak else 15.0
        elif t.startswith(tok) or tok.startswith(t):
            score += 35.0
        elif len(tok) >= 3 and len(t) >= 3 and _edit_distance(t, tok) <= 1:
            score += 28.0
    # frequency soft boost (log-ish)
    if count > 0:
        score += min(25.0, 4.0 * math.log1p(count))
        if not weak and count >= 3 and score > 0:
            score += 5.0
    return score


def match_library_tags(
    query: str,
    tag_counts: dict[str, int] | None,
    *,
    limit: int = 8,
) -> list[dict]:
    """
    Autocomplete-style match against tag library.
    Returns [{name, count, score}, ...] sorted best-first.
    """
    q = canonical_tag(query or "")
    if not q or not tag_counts:
        return []
    scored: list[tuple[float, str, int]] = []
    for name, cnt in tag_counts.items():
        n = canonical_tag(name)
        if not n:
            continue
        sc = 0.0
        if n == q:
            sc = 1000.0
        elif n.startswith(q):
            sc = 500.0 - len(n) * 0.1
        elif q in n:
            sc = 300.0 - n.index(q) * 2
        elif n in q and len(n) >= 2:
            sc = 200.0
        else:
            d = _edit_distance(n, q)
            max_d = 1 if len(q) < 5 else 2
            if d <= max_d:
                sc = 150.0 - d * 40
            else:
                continue
        sc += min(40.0, math.log1p(cnt or 0) * 6)
        if n in WEAK_TAGS:
            sc *= 0.85
        scored.append((sc, n, int(cnt or 0)))
    scored.sort(key=lambda x: (-x[0], -x[2], x[1]))
    out: list[dict] = []
    seen: set[str] = set()
    for sc, n, cnt in scored:
        if n in seen:
            continue
        seen.add(n)
        out.append({"name": n, "count": cnt, "score": round(sc, 2)})
        if len(out) >= max(1, limit):
            break
    return out


def near_duplicate_tag(
    name: str,
    tag_counts: dict[str, int] | None,
    *,
    min_count: int = 2,
) -> str | None:
    """
    If `name` is almost an existing library tag (edit distance ≤1) and that
    tag is used enough, return the library name for soft correction.
    """
    t = canonical_tag(name)
    if not t or not tag_counts:
        return None
    if t in tag_counts:
        return None
    best: tuple[float, str] | None = None
    for lib, cnt in tag_counts.items():
        n = canonical_tag(lib)
        if not n or n == t or (cnt or 0) < min_count:
            continue
        d = _edit_distance(t, n)
        max_d = 1 if max(len(t), len(n)) < 6 else 2
        if d > max_d or d == 0:
            continue
        # prefer higher count, smaller distance
        rank = (cnt or 0) / (1 + d)
        if best is None or rank > best[0]:
            best = (rank, n)
    return best[1] if best else None


def suggest_tags(
    *,
    title: str = "",
    url: str = "",
    media_type: str = "",
    source_page: str = "",
    existing_pool: list[str] | None = None,
    tag_counts: dict[str, int] | None = None,
    limit: int = SUGGEST_DEFAULT_LIMIT,
) -> list[str]:
    """
    Rule-based tag suggestions for ingest dialog / API.

    Prefer title tokens + library tags that match title/url;
    put format & site tags last. `limit` only caps suggestion list length.
    """
    strong: list[str] = []
    weak: list[str] = []
    title_toks = _title_tokens(title or "")
    for tok in title_toks:
        strong.append(tok)

    blob = f"{title} {url} {source_page}".lower()

    # Build counts map from pool if needed
    counts: dict[str, int] = dict(tag_counts or {})
    if existing_pool and not counts:
        for p in existing_pool:
            p = canonical_tag(str(p or ""))
            if p:
                counts[p] = counts.get(p, 0) + 1

    # Score library tags against this media
    lib_hits: list[tuple[float, str]] = []
    for p, cnt in counts.items():
        p = canonical_tag(str(p or ""))
        if not p:
            continue
        sc = pool_match_score(p, blob=blob, title_toks=title_toks, count=cnt)
        if sc >= 28.0:  # threshold: avoid dumping pure popular tags
            lib_hits.append((sc, p))
    lib_hits.sort(key=lambda x: (-x[0], x[1]))
    for sc, p in lib_hits[: max(8, int(limit or SUGGEST_DEFAULT_LIMIT))]:
        (weak if p in WEAK_TAGS else strong).append(p)

    # Also plain pool membership in blob (legacy path)
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

    # Hot strong tags (freq≥3) with zero media match still not auto-added —
    # only title/rule based. Cap result.
    cap = max(1, int(limit or SUGGEST_DEFAULT_LIMIT))
    return normalize_tags(strong + weak)[:cap]


def collect_tag_counts(tag_lists: list[list[str]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for tags in tag_lists:
        for t in set(normalize_tags(tags or [])):
            counts[t] = counts.get(t, 0) + 1
    return counts
