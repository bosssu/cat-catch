from __future__ import annotations

from app.core.config import AppConfig, _DEFAULTS
from app.core.filters import apply_filters, is_quality
from app.core.models import MediaCandidate, MediaType, SourceKind


def _cfg(**capture_overrides) -> AppConfig:
    data = {
        "capture": {
            **_DEFAULTS["capture"],
            **capture_overrides,
        }
    }
    return AppConfig(data, path=None)  # type: ignore[arg-type]


def _cand(**kwargs) -> MediaCandidate:
    defaults = dict(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url="https://cdn.example.com/a.png",
        width=800,
        height=600,
        bytes_hint=100_000,
        score=0.6,
    )
    defaults.update(kwargs)
    return MediaCandidate(**defaults)


def test_apply_filters_min_edge():
    cfg = _cfg(min_edge_px=200, min_bytes=0, skip_avatar_like=False)
    small = _cand(width=100, height=100)
    big = _cand(width=400, height=300)
    out = apply_filters([small, big], cfg)
    assert small.filtered_out is True
    assert "边长" in small.filter_reason
    assert big.filtered_out is False
    assert len(out) == 2


def test_apply_filters_types():
    cfg = _cfg(types=["image"], min_edge_px=0, min_bytes=0, skip_avatar_like=False)
    img = _cand(media_type=MediaType.IMAGE)
    vid = _cand(media_type=MediaType.VIDEO, source_url="https://cdn.example.com/v.mp4")
    out = apply_filters([img, vid], cfg)
    assert img.filtered_out is False
    assert vid.filtered_out is True
    assert "类型" in vid.filter_reason
    assert len(out) == 2


def test_apply_filters_avatar_skip_by_size():
    cfg = _cfg(min_edge_px=0, min_bytes=0, skip_avatar_like=True)
    avatar = _cand(width=64, height=64, source_url="https://cdn.example.com/icon.png")
    photo = _cand(width=800, height=600)
    apply_filters([avatar, photo], cfg)
    assert avatar.filtered_out is True
    assert "头像" in avatar.filter_reason or "emoji" in avatar.filter_reason
    assert photo.filtered_out is False


def test_apply_filters_avatar_skip_by_url():
    cfg = _cfg(min_edge_px=0, min_bytes=0, skip_avatar_like=True)
    av = _cand(width=None, height=None, source_url="https://cdn.discordapp.com/avatars/1/x.png")
    apply_filters([av], cfg)
    assert av.filtered_out is True
    assert "URL" in av.filter_reason or "头像" in av.filter_reason


def test_is_quality_filtered_false():
    c = _cand()
    c.filtered_out = True
    assert is_quality(c) is False


def test_is_quality_screenshot():
    c = _cand(source_kind=SourceKind.SCREENSHOT, width=50, height=50, score=0.0, bytes_hint=10)
    assert is_quality(c) is True


def test_is_quality_large_edge():
    c = _cand(width=500, height=500, score=0.0, bytes_hint=10)
    assert is_quality(c) is True


def test_is_quality_bytes_and_score():
    by_bytes = _cand(width=100, height=100, bytes_hint=90_000, score=0.0)
    by_score = _cand(width=100, height=100, bytes_hint=10, score=0.7)
    low = _cand(width=100, height=100, bytes_hint=10, score=0.1)
    assert is_quality(by_bytes) is True
    assert is_quality(by_score) is True
    assert is_quality(low) is False


def test_is_quality_unknown_dims():
    c = _cand(width=None, height=None, bytes_hint=None, score=0.0)
    assert is_quality(c) is True
