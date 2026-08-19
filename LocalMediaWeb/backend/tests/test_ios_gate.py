"""iPhone 13 ingest codec gate (reject AV1/VP9, allow H.264/HEVC)."""
from __future__ import annotations

from app.services.hls import HlsError, _pick_variant
from app.services.media_process import ios_codecs_declared_ok, ios_probe_blob_ok


def test_declared_h264_hevc_ok():
    assert ios_codecs_declared_ok("avc1.42E01E,mp4a.40.2")[0]
    assert ios_codecs_declared_ok("hvc1.1.6.L93.B0,mp4a.40.2")[0]
    assert ios_codecs_declared_ok("hev1.1.6.L120.B0,mp4a.40.2")[0]
    assert ios_codecs_declared_ok("")[0]


def test_declared_av1_vp9_opus_rejected():
    assert not ios_codecs_declared_ok("av01.0.08M.08,mp4a.40.2")[0]
    assert not ios_codecs_declared_ok("av1.0.05M.08")[0]
    assert not ios_codecs_declared_ok("vp09.00.10.08,opus")[0]
    assert not ios_codecs_declared_ok("avc1.42E01E,opus")[0]


def test_probe_blob():
    assert ios_probe_blob_ok("h264,video\naac,audio")[0]
    assert ios_probe_blob_ok("hevc,video\naac,audio")[0]
    assert not ios_probe_blob_ok("av1,video\naac,audio")[0]
    assert not ios_probe_blob_ok("vp9,video\nopus,audio")[0]
    assert ios_probe_blob_ok("")[0]


def test_hls_picks_avc_not_av1():
    text = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42E01E,mp4a.40.2"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="av01.0.08M.08,mp4a.40.2"
hi.m3u8
"""
    url = _pick_variant(text, "https://cdn.example/master.m3u8")
    assert url.endswith("low.m3u8")


def test_hls_picks_hevc():
    text = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="hvc1.1.6.L93.B0,mp4a.40.2"
hevc.m3u8
"""
    url = _pick_variant(text, "https://cdn.example/master.m3u8")
    assert url.endswith("hevc.m3u8")


def test_attach_ios_fields_webm_and_av1():
    from pathlib import Path

    from app.services.media_process import _attach_ios_fields

    webm = {"media_type": "video", "vcodec": "vp9", "acodec": "opus"}
    _attach_ios_fields(webm, Path("clip.webm"))
    assert webm["ios_ok"] is False

    av1 = {"media_type": "video", "vcodec": "av1", "acodec": "aac"}
    _attach_ios_fields(av1, Path("clip.mp4"))
    assert av1["ios_ok"] is False

    ok = {"media_type": "video", "vcodec": "h264", "acodec": "aac"}
    _attach_ios_fields(ok, Path("clip.mp4"))
    assert ok["ios_ok"] is True

    unknown = {"media_type": "video", "vcodec": "", "acodec": ""}
    _attach_ios_fields(unknown, Path("clip.mp4"))
    assert unknown["ios_ok"] is None


def test_hls_av1_only_raises():
    text = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="av01.0.04M.08,mp4a.40.2"
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="av01.0.08M.08,mp4a.40.2"
b.m3u8
"""
    try:
        _pick_variant(text, "https://cdn.example/master.m3u8")
        raise AssertionError("expected HlsError")
    except HlsError as e:
        assert e.codec_reject
        assert "iPhone" in str(e)
