from __future__ import annotations

from app.core.models import MediaCandidate, MediaType, SourceKind
from app.core.scoring import score_candidate, sort_candidates


def test_sort_recommend_higher_score_first():
    low = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.SCREENSHOT,
        width=100,
        height=100,
        bytes_hint=1000,
    )
    high = MediaCandidate(
        media_type=MediaType.VIDEO,
        source_kind=SourceKind.NETWORK,
        width=1920,
        height=1080,
        bytes_hint=5_000_000,
    )
    mid = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.CACHE,
        width=800,
        height=600,
        bytes_hint=200_000,
    )
    ordered = sort_candidates([low, high, mid], mode="recommend")
    assert ordered[0] is high
    assert ordered[0].score >= ordered[1].score >= ordered[2].score


def test_score_candidate_sets_score():
    c = MediaCandidate(
        media_type=MediaType.GIF,
        source_kind=SourceKind.NETWORK,
        width=500,
        height=500,
        bytes_hint=50_000,
    )
    s = score_candidate(c)
    assert s == c.score
    assert s > 0
