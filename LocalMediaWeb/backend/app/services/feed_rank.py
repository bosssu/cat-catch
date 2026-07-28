"""Lightweight Feed ranking for personal local library (not social CF)."""

from __future__ import annotations

import math
import random
import time
from datetime import datetime, timezone

from app.models.entities import MediaItem

# Higher → more shuffle; scores stay preferred via softmax/Gumbel.
# ~22 keeps liked/recency meaningful while order varies across refreshes.
RECOMMEND_TEMPERATURE = 22.0


def _ts(dt: datetime | None) -> float:
    if not dt:
        return 0.0
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()


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

    # Prefer liked; penalize repeatedly skipped
    s = 0.0
    s += liked * 120.0
    s += math.log1p(views) * 8.0
    s += math.log1p(dwell / 1000.0) * 6.0
    s -= skips * 35.0

    # Recency: newer items a bit higher (half-life ~14 days)
    age_days = max(0.0, (now - created) / 86400.0) if created else 30.0
    s += 40.0 * math.exp(-age_days / 14.0)

    # Soft exploration: not seen recently
    if last_view:
        hours = max(0.0, (now - last_view) / 3600.0)
        s += min(25.0, hours * 0.5)
    else:
        s += 15.0  # never viewed

    return s


def _gumbel_noise(temperature: float) -> float:
    """Gumbel(0, T) via inverse CDF (stdlib random has no gumbelvariate)."""
    t = max(1e-6, float(temperature))
    # U ~ Uniform(0,1); Gumbel = -T * log(-log(U))
    u = random.random()
    # clamp away from 0/1 so log is stable
    u = min(max(u, 1e-12), 1.0 - 1e-12)
    return -t * math.log(-math.log(u))


def _softmax_rank(
    scored: list[tuple[float, MediaItem]],
    limit: int,
    temperature: float = RECOMMEND_TEMPERATURE,
) -> list[MediaItem]:
    """
    Rank by score + Gumbel noise, then light category diversity.
    Each call yields a different order while high-score items still appear
    more often (softmax sampling / Plackett–Luce style).
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
        last_cat = out[-1].category
        # Among top candidates, prefer a different category with ~70% chance
        window = rest[: min(14, len(rest))]
        alt = [i for i, m in enumerate(window) if m.category != last_cat]
        if alt and random.random() < 0.72:
            pick_i = random.choice(alt)
        else:
            # Soft random among top-3 instead of always #0
            k = min(3, len(window))
            pick_i = random.randrange(k)
        out.append(rest.pop(pick_i))
    return out


def rank_recommend(items: list[MediaItem], limit: int = 30) -> list[MediaItem]:
    now = time.time()
    scored = [(score_item(m, now), m) for m in items]
    return _softmax_rank(scored, limit)


def category_affinity(items: list[MediaItem]) -> dict[str, float]:
    """How much user likes each category from liked/views."""
    aff: dict[str, float] = {}
    for m in items:
        c = m.category or "default"
        aff.setdefault(c, 0.0)
        if getattr(m, "liked", False):
            aff[c] += 5.0
        aff[c] += math.log1p(int(getattr(m, "view_count", 0) or 0)) * 0.5
        aff[c] -= int(getattr(m, "skip_count", 0) or 0) * 0.8
    return aff


def rank_recommend_with_affinity(items: list[MediaItem], limit: int = 30) -> list[MediaItem]:
    aff = category_affinity(items)
    now = time.time()
    scored: list[tuple[float, MediaItem]] = []
    for m in items:
        base = score_item(m, now)
        base += aff.get(m.category or "default", 0.0) * 2.0
        scored.append((base, m))
    return _softmax_rank(scored, limit)
