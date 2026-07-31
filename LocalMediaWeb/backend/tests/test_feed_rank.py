"""Unit tests for feed ranking (no DB required for pure functions)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.feed_rank import (
    FeedRankParams,
    diversify_sequence,
    fatigue_penalty,
    quality_ratio,
    rank_recommend_with_affinity,
    score_item,
)


def _item(**kwargs):
    now = datetime.now(timezone.utc)
    base = dict(
        id=1,
        liked=False,
        view_count=0,
        skip_count=0,
        dwell_ms_total=0,
        last_viewed_at=None,
        created_at=now - timedelta(days=7),
        tags_json='["cats"]',
        media_type="video",
        title="t",
        source_url="",
    )
    base.update(kwargs)
    return SimpleNamespace(**base)


def test_fatigue_recently_viewed_higher_than_old():
    now = datetime.now(timezone.utc)
    recent = _item(last_viewed_at=now - timedelta(minutes=10))
    old = _item(last_viewed_at=now - timedelta(days=10))
    ts = now.timestamp()
    assert fatigue_penalty(recent, ts) > fatigue_penalty(old, ts) * 3
    assert score_item(old, ts) > score_item(recent, ts)


def test_liked_scores_above_neutral():
    liked = _item(liked=True, id=1)
    plain = _item(liked=False, id=2)
    assert score_item(liked) > score_item(plain)


def test_quality_ratio_penalizes_skip_heavy():
    good = _item(view_count=5, dwell_ms_total=60_000, skip_count=0)
    bad = _item(view_count=5, dwell_ms_total=1_000, skip_count=5)
    assert quality_ratio(good) > quality_ratio(bad)


def test_diversify_avoids_same_type_when_possible():
    items = [
        _item(id=1, media_type="video", tags_json='["a"]'),
        _item(id=2, media_type="video", tags_json='["a"]'),
        _item(id=3, media_type="image", tags_json='["b"]'),
        _item(id=4, media_type="video", tags_json='["c"]'),
    ]
    out = diversify_sequence(items, limit=4)
    types = [m.media_type for m in out[:3]]
    # first three should not be all video if image is available early
    assert "image" in types


def test_recommend_puts_liked_before_skipped_junk():
    now = datetime.now(timezone.utc)
    liked = _item(
        id=1,
        liked=True,
        tags_json='["anime"]',
        dwell_ms_total=30_000,
        view_count=3,
        last_viewed_at=now - timedelta(days=3),
    )
    junk = _item(
        id=2,
        liked=False,
        tags_json='["anime"]',
        skip_count=8,
        view_count=8,
        dwell_ms_total=500,
        last_viewed_at=now - timedelta(minutes=5),
    )
    filler = [
        _item(
            id=10 + i,
            tags_json='["other"]',
            view_count=0,
            created_at=now - timedelta(days=i),
        )
        for i in range(8)
    ]
    ranked = rank_recommend_with_affinity(
        [junk, liked, *filler],
        limit=5,
        params=FeedRankParams(temperature=1.0, explore_every=0),
    )
    ids = [m.id for m in ranked]
    assert 1 in ids
    # with low temperature, liked should appear before junk
    assert ids.index(1) < ids.index(2) if 2 in ids else True


def test_recommend_includes_unseen_when_explore_on():
    now = datetime.now(timezone.utc)
    # strong interest cluster
    cluster = [
        _item(
            id=100 + i,
            liked=True if i == 0 else False,
            tags_json='["dogs"]',
            view_count=5,
            dwell_ms_total=20_000,
            last_viewed_at=now - timedelta(days=2),
        )
        for i in range(6)
    ]
    unseen = _item(
        id=999,
        tags_json='["unrelated_topic_xyz"]',
        view_count=0,
        last_viewed_at=None,
        created_at=now - timedelta(days=40),
    )
    ranked = rank_recommend_with_affinity(
        [*cluster, unseen],
        limit=8,
        params=FeedRankParams(temperature=5.0, explore_every=3, w_explore=0.35),
    )
    ids = [m.id for m in ranked]
    # not guaranteed every run with stochastic explore, but high explore weight + force slot
    # should surface 999 often; allow a few retries
    found = 999 in ids
    if not found:
        for _ in range(12):
            ranked = rank_recommend_with_affinity(
                [*cluster, unseen],
                limit=8,
                params=FeedRankParams(temperature=8.0, explore_every=2, w_explore=0.4),
            )
            if 999 in [m.id for m in ranked]:
                found = True
                break
    assert found
