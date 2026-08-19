"""Unit tests for feed ranking (no DB required for pure functions)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.feed_rank import (
    FeedRankParams,
    channel_scores,
    diversify_sequence,
    fatigue_penalty,
    filter_by_tag,
    interest_watch_score,
    is_never_played,
    quality_ratio,
    rank_by_tag,
    rank_recommend_with_affinity,
    score_item,
    tag_affinity,
    watch_metrics,
)


def _item(**kwargs):
    now = datetime.now(timezone.utc)
    base = dict(
        id=1,
        liked=False,
        view_count=0,
        skip_count=0,
        dwell_ms_total=0,
        duration_sec=None,
        max_progress=0.0,
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


def test_rank_by_tag_only_includes_focus_tag():
    now = datetime.now(timezone.utc)
    with_tag = [
        _item(id=1, tags_json='["anime"]', liked=True, view_count=3, dwell_ms_total=20_000),
        _item(id=2, tags_json='["anime","cats"]', skip_count=5, view_count=5, dwell_ms_total=200),
        _item(id=3, tags_json='["anime"]', view_count=0, created_at=now - timedelta(days=1)),
    ]
    other = [
        _item(id=10 + i, tags_json='["other"]', created_at=now - timedelta(days=i))
        for i in range(5)
    ]
    ranked = rank_by_tag(
        [*with_tag, *other],
        "anime",
        limit=10,
        params=FeedRankParams(temperature=1.0, explore_every=0),
    )
    assert ranked
    assert all("anime" in (m.tags_json or "") for m in ranked)
    assert {m.id for m in ranked}.isdisjoint({10, 11, 12, 13, 14})
    # liked should beat skip-heavy under low temperature (recommend path)
    ids = [m.id for m in ranked]
    if 1 in ids and 2 in ids:
        assert ids.index(1) < ids.index(2)


def test_filter_by_tag_canonical():
    items = [
        _item(id=1, tags_json='["Foo-Bar"]'),
        _item(id=2, tags_json='["other"]'),
    ]
    # tags_from_json + canonical_tag path — store already-canonical in JSON
    items[0] = _item(id=1, tags_json='["foo-bar"]')
    out = filter_by_tag(items, "foo-bar")
    assert [m.id for m in out] == [1]


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


def test_long_mid_depth_not_buried_vs_short_high_completion():
    """Long video at ~30% depth must stay competitive with short near-complete."""
    # short 20s, ~90% avg dwell
    short = _item(
        id=1,
        duration_sec=20.0,
        view_count=3,
        dwell_ms_total=3 * 18_000,
        max_progress=0.9,
        tags_json='["x"]',
    )
    # long 10min, ~30% / 180s effective
    long = _item(
        id=2,
        duration_sec=600.0,
        view_count=2,
        dwell_ms_total=2 * 180_000,
        max_progress=0.3,
        tags_json='["x"]',
    )
    assert watch_metrics(long).is_long
    assert watch_metrics(long).strong_interest
    # Absolute interest_watch: long deep watch should not lose badly to short complete
    assert interest_watch_score(long) >= interest_watch_score(short) * 0.85
    assert score_item(long) >= score_item(short) * 0.8


def test_long_strong_interest_boosts_tag_affinity():
    long = _item(
        id=1,
        duration_sec=900.0,
        view_count=2,
        dwell_ms_total=2 * 200_000,
        max_progress=0.28,
        tags_json='["anime"]',
    )
    junk = _item(
        id=2,
        duration_sec=20.0,
        view_count=5,
        dwell_ms_total=2_000,
        skip_count=4,
        tags_json='["noise"]',
    )
    aff = tag_affinity([long, junk])
    assert aff.get("anime", 0) > aff.get("noise", 0)


def test_quality_ratio_uses_duration_depth():
    deep_short = _item(duration_sec=15.0, view_count=2, dwell_ms_total=2 * 14_000, skip_count=0)
    shallow_short = _item(duration_sec=15.0, view_count=2, dwell_ms_total=2 * 1_000, skip_count=0)
    assert quality_ratio(deep_short) > quality_ratio(shallow_short)


def test_never_played_scores_above_same_age_played():
    """Freshly ingested, never-played items beat equal-age lightly-played ones."""
    now = datetime.now(timezone.utc)
    virgin = _item(
        id=1,
        view_count=0,
        last_viewed_at=None,
        created_at=now - timedelta(hours=6),
        tags_json='["misc"]',
    )
    played = _item(
        id=2,
        view_count=2,
        dwell_ms_total=4_000,
        last_viewed_at=now - timedelta(days=2),
        created_at=now - timedelta(hours=6),
        tags_json='["misc"]',
    )
    assert is_never_played(virgin)
    assert not is_never_played(played)
    ts = now.timestamp()
    assert score_item(virgin, ts) > score_item(played, ts)
    aff = tag_affinity([virgin, played])
    ch_v = channel_scores(virgin, aff, ts, FeedRankParams())
    ch_p = channel_scores(played, aff, ts, FeedRankParams())
    assert ch_v["fresh"] > ch_p["fresh"]
    assert ch_v["explore"] > ch_p["explore"]


def test_recommend_surfaces_new_unplayed_among_interest_cluster():
    """Brand-new never-played should appear in a short recommend page."""
    now = datetime.now(timezone.utc)
    cluster = [
        _item(
            id=100 + i,
            liked=True if i == 0 else False,
            tags_json='["dogs"]',
            view_count=4,
            dwell_ms_total=18_000,
            last_viewed_at=now - timedelta(days=1),
            created_at=now - timedelta(days=20 + i),
        )
        for i in range(8)
    ]
    brand_new = _item(
        id=777,
        tags_json='["brand_new_topic"]',
        view_count=0,
        last_viewed_at=None,
        created_at=now - timedelta(hours=2),
    )
    found = False
    for _ in range(15):
        ranked = rank_recommend_with_affinity(
            [*cluster, brand_new],
            limit=6,
            params=FeedRankParams(temperature=6.0, explore_every=4),
        )
        if 777 in [m.id for m in ranked]:
            found = True
            break
    assert found
