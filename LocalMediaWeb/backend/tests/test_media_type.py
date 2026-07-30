"""Tests for media type detection and extension guessing (incl. audio)."""

from __future__ import annotations

from app.services.util import detect_media_type, guess_ext


def test_detect_audio_by_extension():
    for url in (
        "https://cdn.example/a.mp3",
        "file:///x/y/z.m4a",
        "track.aac",
        "x.ogg?token=1",
        "s.opus",
        "w.wav",
        "f.flac",
    ):
        assert detect_media_type(url, None, None) == "audio", url


def test_detect_audio_by_content_type():
    assert detect_media_type("https://x/blob", "audio/mpeg", None) == "audio"
    assert detect_media_type("https://x/blob", "audio/mp4; charset=binary", None) == "audio"


def test_detect_audio_hint():
    assert detect_media_type("https://x/unknown.bin", None, "audio") == "audio"


def test_detect_image_and_video_unchanged():
    assert detect_media_type("a.png", None, None) == "image"
    assert detect_media_type("a.gif", None, None) == "gif"
    assert detect_media_type("a.mp4", None, None) == "video"
    assert detect_media_type("a.m3u8", None, None) == "m3u8"
    assert detect_media_type("a.mpd", None, None) == "dash"


def test_guess_ext_audio():
    assert guess_ext("https://x/a.mp3", None, "audio") == "mp3"
    assert guess_ext("https://x/blob", "audio/mpeg", "audio") == "mp3"
    assert guess_ext("https://x/blob", "audio/flac", "audio") == "flac"
    assert guess_ext("https://x/unknown", None, "audio") == "mp3"
