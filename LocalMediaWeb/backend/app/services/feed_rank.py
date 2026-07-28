"""Lightweight Feed ranking for personal local library (not social CF)."""

from __future__ import annotations

import math
import random
import time
from datetime import datetime, timezone

from app.models.entities import MediaItem
from app.services.tags import (
    canonical_tag,
    strong_tags,
    tag_idf_weights,
    tags_from_json,
    title_overlap,
    title_tokens,
    url_host,
    weighted_jaccard,
)

# Higher → more shuffle; scores stay preferred via softmax/Gumbel.
RECOMMEND_TEMPERATURE = 22.0

# Personal score only breaks ties in "similar" mode (must not drown tag mismatch).
SIMILAR_PERSONAL_CAP = 12.0
# Title token Jaccard must clear this when used as sole similarity gate.
SIMILAR_TITLE_MIN = 0.18


def _ts(dt: datetime | None) -> float:
    if not dt:
        return 0.0
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()


def _tags(m: MediaItem) -> list[str]:
    return tags_from_json(getattr(m, "tags_json", None) or "[]")


def score_item(m: MediaItem, now: float | None = None) -> float:
    """
    Explicit signals dominate; implicit (view/dwell) mild boost;
    recency keeps feed fresh. Stochastic noise is applied at rank time
    (Gumbel-max), not inside the base score.
    """
    now = now or time.time()
    liked = 1.0 if getattr(m, "liked", False) else 0.0
    views = max(0, int(getattr(m, "view_count", 0) or 0))
    skips = max(0, int(getattr(m, "skip_count", 0) or 0))
    dwell = max(0, int(getattr(m, "dwell_ms_total", 0) or 0))
    created = _ts(getattr(m, "created_at", None))
    last_view = _ts(getattr(m, "last_viewed_at", None))

    s = 0.0
    s += liked * 120.0
    s += math.log1p(views) * 8.0
    s += math.log1p(dwell / 1000.0) * 6.0
    s -= skips * 35.0

    age_days = max(0.0, (now - created) / 86400.0) if created else 30.0
    s += 40.0 * math.exp(-age_days / 14.0)

    if last_view:
        hours = max(0.0, (now - last_view) / 3600.0)
        s += min(25.0, hours * 0.5)
    else:
        s += 15.0

    return s


def _gumbel_noise(temperature: float) -> float:
    t = max(1e-6, float(temperature))
    u = random.random()
    u = min(max(u, 1e-12), 1.0 - 1e-12)
    return -t * math.log(-math.log(u))


def _tag_set(m: MediaItem) -> frozenset[str]:
    return frozenset(_tags(m))


def _softmax_rank(
    scored: list[tuple[float, MediaItem]],
    limit: int,
    temperature: float = RECOMMEND_TEMPERATURE,
) -> list[MediaItem]:
    """
    Rank by score + Gumbel noise, then light tag diversity.
    """
    if not scored:
        return []
    noisy = [(s + _gumbel_noise(temperature), m) for s, m in scored]
    noisy.sort(key=lambda x: x[0], reverse=True)
    rest = [m for _, m in noisy]
    out: list[MediaItem] = []
    while rest and len(out) < limit:
        if len(out) < 2:
            out.append(rest.pop(0))
            continue
        last_tags = _tag_set(out[-1])
        window = rest[: min(14, len(rest))]
        # Prefer different tag set when possible
        alt = [
            i
            for i, m in enumerate(window)
            if last_tags and _tag_set(m) != last_tags
        ]
        if alt and random.random() < 0.72:
            pick_i = random.choice(alt)
        else:
            k = min(3, len(window))
            pick_i = random.randrange(k)
        out.append(rest.pop(pick_i))
    return out


def rank_recommend(items: list[MediaItem], limit: int = 30) -> list[MediaItem]:
    now = time.time()
    scored = [(score_item(m, now), m) for m in items]
    return _softmax_rank(scored, limit)


def tag_affinity(items: list[MediaItem]) -> dict[str, float]:
    """How much user likes each tag from liked/views."""
    aff: dict[str, float] = {}
    for m in items:
        for t in _tags(m):
            aff.setdefault(t, 0.0)
            if getattr(m, "liked", False):
                aff[t] += 5.0
            aff[t] += math.log1p(int(getattr(m, "view_count", 0) or 0)) * 0.5
            aff[t] -= int(getattr(m, "skip_count", 0) or 0) * 0.8
    return aff


def rank_recommend_with_affinity(items: list[MediaItem], limit: int = 30) -> list[MediaItem]:
    aff = tag_affinity(items)
    now = time.time()
    scored: list[tuple[float, MediaItem]] = []
    for m in items:
        base = score_item(m, now)
        for t in _tags(m):
            base += aff.get(t, 0.0) * 1.2
        scored.append((base, m))
    return _softmax_rank(scored, limit)


def _similar_related(
    seed_tags: list[str],
    cand_tags: list[str],
    seed_title: str,
    cand_title: str,
    seed_host: str,
    cand_host: str,
    title_sim: float,
) -> bool:
    """
    Hard gate: do not surface items that only share weak format/site tags
    or personal popularity. Content must share strong tags, title tokens,
    or (when seed has no strong tags) a clear host/title signal.
    """
    seed_strong = set(strong_tags(seed_tags))
    cand_strong = set(strong_tags(cand_tags))
    shared_strong = seed_strong & cand_strong

    if shared_strong:
        return True
    if title_sim >= SIMILAR_TITLE_MIN:
        return True

    # Seed has semantic tags but candidate shares none → not similar.
    if seed_strong:
        return False

    # Seed has only weak/no tags: allow same host or title token hit.
    if seed_host and cand_host and seed_host == cand_host:
        return True
    if title_tokens(seed_title) and title_tokens(cand_title):
        # any shared token even if jaccard is low (different length titles)
        if set(title_tokens(seed_title)) & set(title_tokens(cand_title)):
            return True
    return False


def rank_similar(
    items: list[MediaItem],
    seed: MediaItem,
    limit: int = 30,
) -> list[MediaItem]:
    """
    Similar feed: content signals only (IDF tags, title, host, type).
    Personal score is capped and used only as a light tie-break so
    popular but unrelated items cannot crowd out true tag matches.
    """
    seed_tags = _tags(seed)
    seed_id = seed.id
    seed_title = getattr(seed, "title", "") or ""
    seed_host = url_host(getattr(seed, "source_url", "") or "")
    seed_type = (getattr(seed, "media_type", "") or "").lower().strip()
    now = time.time()

    corpus = [_tags(m) for m in items]
    weights = tag_idf_weights(corpus)

    scored: list[tuple[float, MediaItem]] = []
    for m in items:
        if m.id == seed_id:
            continue
        mt = _tags(m)
        cand_title = getattr(m, "title", "") or ""
        cand_host = url_host(getattr(m, "source_url", "") or "")
        t_sim = title_overlap(seed_title, cand_title)

        if not _similar_related(
            seed_tags,
            mt,
            seed_title,
            cand_title,
            seed_host,
            cand_host,
            t_sim,
        ):
            continue

        wjac = weighted_jaccard(seed_tags, mt, weights)
        shared_strong_n = len(set(strong_tags(seed_tags)) & set(strong_tags(mt)))
        same_host = 1.0 if seed_host and cand_host and seed_host == cand_host else 0.0
        same_type = (
            1.0
            if seed_type
            and (getattr(m, "media_type", "") or "").lower().strip() == seed_type
            else 0.0
        )
        personal = min(SIMILAR_PERSONAL_CAP, max(0.0, score_item(m, now) * 0.05))

        # Content dominates; personal ≤ ~12.
        s = (
            wjac * 220.0
            + shared_strong_n * 55.0
            + t_sim * 90.0
            + same_host * 28.0
            + same_type * 8.0
            + personal
        )
        scored.append((s, m))

    scored.sort(key=lambda x: x[0], reverse=True)
    out = [seed]
    for _, m in scored:
        if len(out) >= limit:
            break
        out.append(m)
    return out


def rank_by_tag(
    items: list[MediaItem],
    tag: str,
    limit: int = 30,
    *,
    exclude_id: int | None = None,
) -> list[MediaItem]:
    """
    Similar-by-tag: only items that carry `tag`, ordered by
    recency + light personal score (not full multi-tag jaccard).
    """
    t = canonical_tag(tag or "")
    if not t:
        return []
    now = time.time()
    scored: list[tuple[float, MediaItem]] = []
    for m in items:
        if exclude_id is not None and m.id == exclude_id:
            continue
        mt = _tags(m)
        if t not in mt:
            continue
        created = _ts(getattr(m, "created_at", None))
        age_days = max(0.0, (now - created) / 86400.0) if created else 30.0
        recency = 80.0 * math.exp(-age_days / 21.0)
        # id as stable tie-break toward newer rows
        id_boost = min(40.0, float(m.id or 0) * 0.001)
        personal = min(SIMILAR_PERSONAL_CAP, max(0.0, score_item(m, now) * 0.05))
        # Prefer items where this tag is "strong" content (not alone with only weak tags)
        strong = strong_tags(mt)
        purity = 18.0 if t in strong else 6.0
        s = recency + id_boost + personal + purity + shared_bonus(mt, t)
        scored.append((s, m))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:limit]]


def shared_bonus(tags: list[str], focus: str) -> float:
    """Slight boost when the focus tag is among few strong tags (more on-topic)."""
    st = strong_tags(tags)
    if focus in st and len(st) <= 2:
        return 12.0
    if focus in st:
        return 4.0
    return 0.0
