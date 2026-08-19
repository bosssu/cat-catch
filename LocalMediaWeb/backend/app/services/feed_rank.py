"""Lightweight Feed ranking for personal local library (not social CF).

Recommend: multi-channel fusion (interest / fresh / explore / revisit)
+ fatigue + MMR-style diversity + optional explore slots.
Interest uses duration-aware depth / effective-watch (long videos are not
penalized by raw completion rate). Explore hard slots keep cold items alive.
Random: caller should sample with SQL RANDOM(); this module only diversifies.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from app.models.entities import MediaItem
from app.services.tags import (
    canonical_tag,
    strong_tags,
    tags_from_json,
    title_overlap,
    title_tokens,
    url_host,
)

# Higher → more shuffle; scores stay preferred via Gumbel-max.
RECOMMEND_TEMPERATURE = 28.0

# Title token Jaccard must clear this when used as sole similarity gate.
SIMILAR_TITLE_MIN = 0.18

# Duration buckets for watch-depth scoring (seconds).
LONG_DURATION_SEC = 300.0  # ≥5 min: strong interest via depth≈0.25 or effective≥120s
MEDIUM_DURATION_SEC = 60.0

# Defaults (overridable via kwargs / settings)
# Slightly higher fresh/explore so never-played / newly ingested still surfaces.
DEFAULT_CHANNEL_WEIGHTS = {
    "interest": 0.42,
    "fresh": 0.22,
    "explore": 0.24,
    "revisit": 0.12,
}
DEFAULT_FATIGUE_HALF_LIFE_HOURS = 18.0
DEFAULT_EXPLORE_EVERY = 4
# Age window (days) where never-played items get the strongest "new inventory" boost.
NEVER_PLAYED_FRESH_DAYS = 21.0


@dataclass(frozen=True)
class FeedRankParams:
    temperature: float = RECOMMEND_TEMPERATURE
    fatigue_half_life_hours: float = DEFAULT_FATIGUE_HALF_LIFE_HOURS
    explore_every: int = DEFAULT_EXPLORE_EVERY
    w_interest: float = 0.42
    w_fresh: float = 0.22
    w_explore: float = 0.24
    w_revisit: float = 0.12

    @classmethod
    def from_settings(cls, settings: Any | None = None) -> FeedRankParams:
        if settings is None:
            return cls()
        return cls(
            temperature=float(
                getattr(settings, "feed_recommend_temperature", RECOMMEND_TEMPERATURE)
                or RECOMMEND_TEMPERATURE
            ),
            fatigue_half_life_hours=float(
                getattr(
                    settings,
                    "feed_fatigue_half_life_hours",
                    DEFAULT_FATIGUE_HALF_LIFE_HOURS,
                )
                or DEFAULT_FATIGUE_HALF_LIFE_HOURS
            ),
            explore_every=int(
                getattr(settings, "feed_explore_every", DEFAULT_EXPLORE_EVERY)
                if getattr(settings, "feed_explore_every", DEFAULT_EXPLORE_EVERY)
                is not None
                else DEFAULT_EXPLORE_EVERY
            ),
            w_interest=float(getattr(settings, "feed_w_interest", 0.42) or 0.42),
            w_fresh=float(getattr(settings, "feed_w_fresh", 0.22) or 0.22),
            w_explore=float(getattr(settings, "feed_w_explore", 0.24) or 0.24),
            w_revisit=float(getattr(settings, "feed_w_revisit", 0.12) or 0.12),
        )


def _ts(dt: datetime | None) -> float:
    if not dt:
        return 0.0
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()


def is_never_played(m: MediaItem) -> bool:
    """True when the item is in library but has never been opened/played."""
    views = max(0, int(getattr(m, "view_count", 0) or 0))
    last_view = _ts(getattr(m, "last_viewed_at", None))
    return views == 0 and not last_view


def _tags(m: MediaItem) -> list[str]:
    return tags_from_json(getattr(m, "tags_json", None) or "[]")


def _primary_tag(m: MediaItem) -> str:
    st = strong_tags(_tags(m))
    if st:
        return st[0]
    tags = _tags(m)
    return tags[0] if tags else ""


def fatigue_penalty(
    m: MediaItem,
    now: float | None = None,
    half_life_hours: float = DEFAULT_FATIGUE_HALF_LIFE_HOURS,
) -> float:
    """
    Penalty ≥ 0 for recently viewed items.
    Half-life: after `half_life_hours` since last view, penalty ≈ half of peak.
    Peak ~55 when just viewed.
    """
    now = now or time.time()
    last_view = _ts(getattr(m, "last_viewed_at", None))
    if not last_view:
        return 0.0
    hours = max(0.0, (now - last_view) / 3600.0)
    hl = max(0.5, float(half_life_hours))
    # exp decay from 55
    return 55.0 * math.exp(-hours * math.log(2) / hl)


def _duration_sec(m: MediaItem) -> float | None:
    """Known media duration in seconds, or None if missing/invalid."""
    raw = getattr(m, "duration_sec", None)
    if raw is None:
        return None
    try:
        d = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(d) or d <= 0:
        return None
    return d


def _max_progress(m: MediaItem) -> float:
    """Best playback progress ratio reported by client (0..1)."""
    try:
        p = float(getattr(m, "max_progress", 0) or 0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(p):
        return 0.0
    return max(0.0, min(1.0, p))


@dataclass(frozen=True)
class WatchMetrics:
    """Duration-aware watch signals (smoothed per-item aggregates)."""

    views: int
    skips: int
    dwell_s: float
    avg_dwell: float
    duration: float | None
    depth: float  # avg_dwell/duration when known, else heuristic in 0..1.2
    effective: float  # min(avg_dwell, duration) — absolute engagement
    max_progress: float
    is_long: bool
    is_medium: bool
    strong_interest: bool


def watch_metrics(m: MediaItem) -> WatchMetrics:
    """
    Build watch depth / effective-time metrics.

    Long videos: strong interest at ~25% depth or ~120s effective (not full complete).
    Short videos: need higher relative completion.
    """
    views = max(0, int(getattr(m, "view_count", 0) or 0))
    skips = max(0, int(getattr(m, "skip_count", 0) or 0))
    dwell_s = max(0, int(getattr(m, "dwell_ms_total", 0) or 0)) / 1000.0
    # Bayesian smooth: assume 1 prior view with 8s dwell
    avg_dwell = (dwell_s + 8.0) / (views + 1.0)
    dur = _duration_sec(m)
    max_prog = _max_progress(m)
    liked = bool(getattr(m, "liked", False))

    if dur is not None:
        effective = min(avg_dwell, dur * 1.05)
        depth = min(1.2, avg_dwell / max(dur, 1.0))
        is_long = dur >= LONG_DURATION_SEC
        is_medium = (not is_long) and dur >= MEDIUM_DURATION_SEC
    else:
        # No duration: absolute dwell only; treat long sessions as medium/long-ish.
        effective = min(avg_dwell, 900.0)
        # Map avg dwell to a soft "depth" so affinity still works.
        depth = min(1.2, avg_dwell / 45.0)
        is_long = avg_dwell >= 180.0
        is_medium = (not is_long) and avg_dwell >= 45.0

    if liked:
        strong = True
    elif is_long:
        strong = (
            effective >= 120.0
            or depth >= 0.25
            or max_prog >= 0.25
        )
    elif is_medium:
        strong = effective >= 40.0 or depth >= 0.45 or max_prog >= 0.5
    else:
        # short clip / image-like
        strong = (
            depth >= 0.6
            or max_prog >= 0.9
            or (dur is None and avg_dwell >= 25.0)
            or (dur is not None and effective >= max(12.0, (dur or 0) * 0.55))
        )

    return WatchMetrics(
        views=views,
        skips=skips,
        dwell_s=dwell_s,
        avg_dwell=avg_dwell,
        duration=dur,
        depth=depth,
        effective=effective,
        max_progress=max_prog,
        is_long=is_long,
        is_medium=is_medium,
        strong_interest=strong,
    )


def interest_watch_score(m: MediaItem) -> float:
    """
    0–~120 interest from watch behavior (not channel-normalized).

    Combines relative depth + log(effective) + long-video bonus + max_progress.
    Avoids ranking solely by raw completion (which buries long videos).
    """
    wm = watch_metrics(m)
    # Relative depth (cap contribution)
    s = min(1.0, wm.depth) * 42.0
    # Absolute engagement — main lift for long watches
    s += math.log1p(wm.effective) * 10.0
    # Client progress milestones (ended / 25% / 50% …)
    s += wm.max_progress * 22.0
    if wm.is_long:
        # Reward real watch time on long pieces without requiring completion
        s += min(28.0, wm.effective / 10.0)
        if wm.depth >= 0.25 or wm.max_progress >= 0.25:
            s += 12.0
        if wm.effective >= 120.0:
            s += 10.0
    elif wm.is_medium:
        s += min(12.0, wm.effective / 15.0)
    if wm.strong_interest:
        s += 14.0
    # Skip-heavy items: soft damp (hard penalty lives in score_item / channels)
    if wm.views + wm.skips > 0:
        skip_rate = wm.skips / float(wm.views + wm.skips)
        s *= 1.0 - 0.55 * skip_rate
    return max(0.0, s)


def quality_ratio(m: MediaItem) -> float:
    """
    Duration-aware quality: depth + effective watch + progress; skips hurt.
    Scale roughly 0–120 for compatibility with existing channel weights.
    """
    wm = watch_metrics(m)
    skip_rate = wm.skips / max(1.0, float(wm.views + wm.skips))
    if wm.duration is not None:
        base = (
            min(1.0, wm.depth) * 38.0
            + math.log1p(wm.effective) * 8.5
            + wm.max_progress * 18.0
        )
        if wm.is_long:
            base += min(22.0, wm.effective / 12.0)
    else:
        # Legacy absolute dwell path when duration unknown
        base = min(90.0, wm.avg_dwell) * 0.55 + math.log1p(wm.avg_dwell) * 5.0
        base += wm.max_progress * 18.0
    return max(0.0, base * (1.0 - 0.65 * skip_rate))


def score_item(
    m: MediaItem,
    now: float | None = None,
    *,
    fatigue_half_life_hours: float = DEFAULT_FATIGUE_HALF_LIFE_HOURS,
) -> float:
    """
    Explicit signals dominate; duration-aware watch mild boost;
    recency keeps feed fresh; fatigue demotes just-watched items.
    Stochastic noise is applied at rank time (Gumbel-max), not inside the base score.
    """
    now = now or time.time()
    liked = 1.0 if getattr(m, "liked", False) else 0.0
    views = max(0, int(getattr(m, "view_count", 0) or 0))
    skips = max(0, int(getattr(m, "skip_count", 0) or 0))
    dwell = max(0, int(getattr(m, "dwell_ms_total", 0) or 0))
    created = _ts(getattr(m, "created_at", None))
    last_view = _ts(getattr(m, "last_viewed_at", None))
    wm = watch_metrics(m)

    s = 0.0
    s += liked * 120.0
    # Views alone are weak for a personal library (avoid "grind" ranking)
    s += math.log1p(min(views, 50)) * 2.5
    s += interest_watch_score(m) * 0.55
    s += quality_ratio(m) * 0.28
    s -= skips * 35.0
    # short dwell + many skips: "glance and go"
    if views >= 2 and dwell < 2000 * views and skips >= 1:
        s -= 20.0
    if wm.strong_interest and not liked:
        s += 16.0

    age_days = max(0.0, (now - created) / 86400.0) if created else 30.0
    s += 40.0 * math.exp(-age_days / 14.0)

    # cold start / never played — stronger for recently ingested inventory
    if is_never_played(m):
        s += 28.0
        s += 22.0 * math.exp(-age_days / NEVER_PLAYED_FRESH_DAYS)

    # fatigue (strong near last view) replaces pure "hours since view reward"
    s -= fatigue_penalty(m, now, fatigue_half_life_hours)
    if last_view:
        hours = max(0.0, (now - last_view) / 3600.0)
        # mild re-entry boost after fatigue window
        if hours > fatigue_half_life_hours:
            s += min(18.0, (hours - fatigue_half_life_hours) * 0.15)
    else:
        s += 12.0

    return s


def _gumbel_noise(temperature: float) -> float:
    t = max(1e-6, float(temperature))
    u = random.random()
    u = min(max(u, 1e-12), 1.0 - 1e-12)
    return -t * math.log(-math.log(u))


def _tag_set(m: MediaItem) -> frozenset[str]:
    return frozenset(_tags(m))


def _jaccard_tags(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 0.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def diversify_sequence(
    items: list[MediaItem],
    limit: int,
    *,
    prefer_type_change: bool = True,
) -> list[MediaItem]:
    """
    Greedy anti-clump: avoid back-to-back same media_type / primary tag when alternatives exist.
    Used for random mode (post SQL RANDOM sample).
    """
    if not items:
        return []
    rest = list(items)
    out: list[MediaItem] = []
    while rest and len(out) < limit:
        if not out:
            out.append(rest.pop(0))
            continue
        last = out[-1]
        last_type = (getattr(last, "media_type", "") or "").lower()
        last_tag = _primary_tag(last)
        window = rest[: min(16, len(rest))]
        best_i = 0
        for i, m in enumerate(window):
            mt = (getattr(m, "media_type", "") or "").lower()
            pt = _primary_tag(m)
            type_ok = (not prefer_type_change) or (mt != last_type) or not last_type
            tag_ok = (not last_tag) or (pt != last_tag)
            if type_ok and tag_ok:
                best_i = i
                break
            if type_ok or tag_ok:
                best_i = i
        out.append(rest.pop(best_i))
    return out


def _minmax_norm(values: list[float]) -> list[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-9:
        return [0.5 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def tag_affinity(items: list[MediaItem]) -> dict[str, float]:
    """How much user likes each tag from liked / deep-watch / progress; skips hurt."""
    aff: dict[str, float] = {}
    for m in items:
        tags = _tags(m)
        strong = set(strong_tags(tags))
        wm = watch_metrics(m)
        for t in tags:
            # weak format/site tags get less weight when building affinity
            w = 1.0 if t in strong else 0.35
            aff.setdefault(t, 0.0)
            if getattr(m, "liked", False):
                aff[t] += 5.5 * w
            if wm.strong_interest:
                aff[t] += 3.5 * w
            # Depth / effective watch drive affinity more than raw view counts
            aff[t] += min(1.0, wm.depth) * 2.8 * w
            aff[t] += math.log1p(wm.effective) * 0.55 * w
            aff[t] += wm.max_progress * 2.2 * w
            aff[t] += math.log1p(wm.views) * 0.15 * w
            aff[t] -= wm.skips * 0.85 * w
    return aff


def _affinity_for_item(m: MediaItem, aff: dict[str, float]) -> float:
    tags = _tags(m)
    if not tags:
        return 0.0
    strong = set(strong_tags(tags))
    s = 0.0
    for t in tags:
        w = 1.2 if t in strong else 0.4
        s += aff.get(t, 0.0) * w
    return s


def channel_scores(
    m: MediaItem,
    aff: dict[str, float],
    now: float,
    params: FeedRankParams,
) -> dict[str, float]:
    """Four logical channels (pre-normalization)."""
    liked = 1.0 if getattr(m, "liked", False) else 0.0
    views = max(0, int(getattr(m, "view_count", 0) or 0))
    skips = max(0, int(getattr(m, "skip_count", 0) or 0))
    created = _ts(getattr(m, "created_at", None))
    last_view = _ts(getattr(m, "last_viewed_at", None))
    aff_s = _affinity_for_item(m, aff)
    fat = fatigue_penalty(m, now, params.fatigue_half_life_hours)
    qr = quality_ratio(m)
    iw = interest_watch_score(m)
    wm = watch_metrics(m)

    interest = (
        liked * 100.0
        + aff_s * 1.25
        + iw * 0.85
        + qr * 0.35
        - skips * 30.0
        - fat * 0.85
    )
    if wm.strong_interest and not liked:
        interest += 12.0

    age_days = max(0.0, (now - created) / 86400.0) if created else 45.0
    never = is_never_played(m)
    # Base recency + extra lift for never-played new inventory (harder to bury under interest)
    fresh = 100.0 * math.exp(-age_days / 14.0) - fat * 0.3
    if never:
        fresh += 42.0 * math.exp(-age_days / NEVER_PLAYED_FRESH_DAYS)
        fresh += 18.0  # floor so any never-played beats equal-age played items on fresh

    # explore: unseen / low affinity / long-tail (cold must stay visible)
    explore = 0.0
    if never:
        explore += 92.0
        # Prefer newly ingested never-played over ancient cold archives
        explore += 28.0 * math.exp(-age_days / NEVER_PLAYED_FRESH_DAYS)
    elif views <= 1:
        explore += 55.0
    else:
        explore += max(0.0, 40.0 - math.log1p(views) * 12.0)
    # low affinity is good for explore
    explore += max(0.0, 38.0 - max(0.0, aff_s) * 2.0)
    # mild boost for unliked long-form never deeply watched (discovery of archives)
    if wm.duration and wm.duration >= LONG_DURATION_SEC and views <= 1 and not liked:
        explore += 8.0
    explore -= fat * 0.5
    explore += random.random() * 8.0  # small stochastic within channel

    # revisit: liked or deep-watch quality, outside fatigue window
    hours_since = (
        max(0.0, (now - last_view) / 3600.0) if last_view else 999.0
    )
    revisit = 0.0
    if liked:
        revisit += 80.0
    if wm.strong_interest:
        revisit += 35.0
    if qr > 18.0 and views >= 1:
        revisit += min(45.0, qr * 0.55)
    # long pieces user actually sat with → worth returning to
    if wm.is_long and wm.effective >= 90.0:
        revisit += 18.0
    if hours_since < params.fatigue_half_life_hours * 0.5:
        revisit -= 60.0  # too soon
    elif hours_since < params.fatigue_half_life_hours * 2:
        revisit += 15.0
    else:
        revisit += 35.0
    revisit -= skips * 15.0

    return {
        "interest": interest,
        "fresh": fresh,
        "explore": explore,
        "revisit": revisit,
    }


def _mmr_rank(
    scored: list[tuple[float, MediaItem, dict[str, float]]],
    limit: int,
    temperature: float,
    explore_every: int,
) -> list[MediaItem]:
    """
    Gumbel-noisy order, then MMR-style pick with primary-tag diversity.
    Periodically force an explore-channel pick.
    """
    if not scored:
        return []

    noisy: list[tuple[float, MediaItem, dict[str, float]]] = [
        (s + _gumbel_noise(temperature), m, ch) for s, m, ch in scored
    ]
    noisy.sort(key=lambda x: x[0], reverse=True)

    rest = list(noisy)
    out: list[MediaItem] = []
    out_tags: list[frozenset[str]] = []

    def pop_best(*, force_explore: bool = False) -> tuple[float, MediaItem, dict[str, float]] | None:
        if not rest:
            return None
        if force_explore and len(rest) > 1:
            # among top window, pick highest explore relative to interest;
            # prefer cold (low views) so long-tail is not score-buried
            window = rest[: min(24, len(rest))]
            best_j = 0
            best_key = -1e18
            for j, (_ns, m, ch) in enumerate(window):
                key = ch.get("explore", 0.0) - 0.35 * ch.get("interest", 0.0)
                v = max(0, int(getattr(m, "view_count", 0) or 0))
                if is_never_played(m):
                    key += 28.0
                    # prefer fresher never-played when forcing an explore slot
                    created = _ts(getattr(m, "created_at", None))
                    if created:
                        age_days = max(0.0, (time.time() - created) / 86400.0)
                        key += 16.0 * math.exp(-age_days / NEVER_PLAYED_FRESH_DAYS)
                elif v <= 1:
                    key += 10.0
                if not getattr(m, "liked", False):
                    key += 4.0
                if key > best_key:
                    best_key = key
                    best_j = j
            return rest.pop(best_j)

        if not out:
            return rest.pop(0)

        last_tags = out_tags[-1] if out_tags else frozenset()
        last_primary = _primary_tag(out[-1]) if out else ""
        window_n = min(18, len(rest))
        best_j = 0
        best_adj = -1e18
        for j in range(window_n):
            ns, m, _ch = rest[j]
            ts = _tag_set(m)
            sim = _jaccard_tags(last_tags, ts)
            # also penalize same primary tag
            prim = _primary_tag(m)
            prim_pen = 12.0 if prim and prim == last_primary else 0.0
            # MMR: score - λ * similarity
            adj = ns - 22.0 * sim - prim_pen
            if adj > best_adj:
                best_adj = adj
                best_j = j
        return rest.pop(best_j)

    while rest and len(out) < limit:
        force = (
            explore_every > 0
            and len(out) > 0
            and (len(out) + 1) % explore_every == 0
        )
        picked = pop_best(force_explore=force)
        if picked is None:
            break
        _ns, m, _ch = picked
        out.append(m)
        out_tags.append(_tag_set(m))
    return out


def rank_recommend(items: list[MediaItem], limit: int = 30) -> list[MediaItem]:
    return rank_recommend_with_affinity(items, limit=limit)


def rank_recommend_with_affinity(
    items: list[MediaItem],
    limit: int = 30,
    params: FeedRankParams | None = None,
) -> list[MediaItem]:
    """
    Multi-channel recommend: interest / fresh / explore / revisit
    + Gumbel + MMR diversity + periodic explore slots.
    """
    if not items:
        return []
    params = params or FeedRankParams()
    aff = tag_affinity(items)
    now = time.time()

    raw_channels: list[dict[str, float]] = []
    for m in items:
        raw_channels.append(channel_scores(m, aff, now, params))

    # normalize each channel across the candidate set
    keys = ("interest", "fresh", "explore", "revisit")
    norms: dict[str, list[float]] = {}
    for k in keys:
        norms[k] = _minmax_norm([ch[k] for ch in raw_channels])

    w_sum = (
        params.w_interest
        + params.w_fresh
        + params.w_explore
        + params.w_revisit
    )
    if w_sum <= 1e-9:
        w_sum = 1.0
    wi, wf, we, wr = (
        params.w_interest / w_sum,
        params.w_fresh / w_sum,
        params.w_explore / w_sum,
        params.w_revisit / w_sum,
    )

    scored: list[tuple[float, MediaItem, dict[str, float]]] = []
    for i, m in enumerate(items):
        final = (
            wi * norms["interest"][i]
            + wf * norms["fresh"][i]
            + we * norms["explore"][i]
            + wr * norms["revisit"][i]
        )
        # scale to ~0-100 so Gumbel temperature is meaningful
        final_s = final * 100.0
        # keep a touch of absolute personal score so liked still wins ties
        final_s += min(25.0, max(-40.0, score_item(m, now, fatigue_half_life_hours=params.fatigue_half_life_hours) * 0.08))
        scored.append((final_s, m, raw_channels[i]))

    return _mmr_rank(
        scored,
        limit,
        temperature=params.temperature,
        explore_every=params.explore_every,
    )


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


def filter_similar_candidates(
    items: list[MediaItem],
    seed: MediaItem,
) -> list[MediaItem]:
    """Hard content gate for media-based similar (excludes seed)."""
    seed_tags = _tags(seed)
    seed_id = seed.id
    seed_title = getattr(seed, "title", "") or ""
    seed_host = url_host(getattr(seed, "source_url", "") or "")
    out: list[MediaItem] = []
    for m in items:
        if m.id == seed_id:
            continue
        mt = _tags(m)
        cand_title = getattr(m, "title", "") or ""
        cand_host = url_host(getattr(m, "source_url", "") or "")
        t_sim = title_overlap(seed_title, cand_title)
        if _similar_related(
            seed_tags,
            mt,
            seed_title,
            cand_title,
            seed_host,
            cand_host,
            t_sim,
        ):
            out.append(m)
    return out


def filter_by_tag(
    items: list[MediaItem],
    tag: str,
    *,
    exclude_id: int | None = None,
) -> list[MediaItem]:
    """Keep items whose tags include the focus tag."""
    t = canonical_tag(tag or "")
    if not t:
        return []
    out: list[MediaItem] = []
    for m in items:
        if exclude_id is not None and m.id == exclude_id:
            continue
        if t in _tags(m):
            out.append(m)
    return out


def rank_similar(
    items: list[MediaItem],
    seed: MediaItem,
    limit: int = 30,
    params: FeedRankParams | None = None,
) -> list[MediaItem]:
    """
    Similar feed (by media): same multi-channel recommend ranking as
    ``rank_recommend_with_affinity``, but only among items related to the seed
    (shared strong tags / title / host). Seed is placed first when present.
    """
    if not items or seed is None:
        return []
    candidates = filter_similar_candidates(items, seed)
    # Prefer recommend on the related pool; if gate is empty, fall back to
    # items that share any seed strong tag (broader).
    if not candidates:
        seed_strong = set(strong_tags(_tags(seed)))
        if seed_strong:
            candidates = [
                m
                for m in items
                if m.id != seed.id and (set(strong_tags(_tags(m))) & seed_strong)
            ]
    ranked = rank_recommend_with_affinity(
        candidates, limit=max(0, limit - 1), params=params
    )
    out: list[MediaItem] = [seed]
    seen = {seed.id}
    for m in ranked:
        if m.id in seen:
            continue
        out.append(m)
        seen.add(m.id)
        if len(out) >= limit:
            break
    return out


def rank_by_tag(
    items: list[MediaItem],
    tag: str,
    limit: int = 30,
    *,
    exclude_id: int | None = None,
    params: FeedRankParams | None = None,
) -> list[MediaItem]:
    """
    Similar-by-tag: same multi-channel recommend ranking as
    ``rank_recommend_with_affinity``, constrained to items that carry ``tag``.

    Previously ordered mostly by recency/id (felt like sequential play).
    """
    filtered = filter_by_tag(items, tag, exclude_id=exclude_id)
    if not filtered:
        return []
    return rank_recommend_with_affinity(filtered, limit=limit, params=params)


def shared_bonus(tags: list[str], focus: str) -> float:
    """Slight boost when the focus tag is among few strong tags (more on-topic)."""
    st = strong_tags(tags)
    if focus in st and len(st) <= 2:
        return 12.0
    if focus in st:
        return 4.0
    return 0.0
