from __future__ import annotations

from app.core.models import MediaType
from app.sources.media_guess import guess_media_type, is_likely_media_url, strip_url_key


def test_guess_from_extension():
    assert guess_media_type("https://x.com/a/photo.jpg") == MediaType.IMAGE
    assert guess_media_type("https://x.com/a/clip.mp4") == MediaType.VIDEO
    assert guess_media_type("https://x.com/a/anim.gif") == MediaType.GIF
    assert guess_media_type("https://x.com/a/song.mp3") == MediaType.AUDIO


def test_guess_from_mime():
    assert guess_media_type("https://x.com/blob", mime="image/png") == MediaType.IMAGE
    assert guess_media_type("https://x.com/blob", mime="image/gif") == MediaType.GIF
    assert guess_media_type("https://x.com/blob", mime="video/mp4") == MediaType.VIDEO


def test_guess_unknown_defaults_image():
    assert guess_media_type("https://example.com/page") == MediaType.IMAGE


def test_is_likely_media_url():
    assert is_likely_media_url("https://cdn.discordapp.com/attachments/1/2/photo.png") is True
    assert is_likely_media_url("https://i.imgur.com/abc.webp") is True
    assert is_likely_media_url("https://example.com/index.html") is False
    assert is_likely_media_url("not-a-url") is False
    assert is_likely_media_url("") is False
    assert is_likely_media_url("https://example.com/x", mime="image/png") is True


def test_strip_url_key():
    assert strip_url_key("https://cdn.example.com/a.png?size=1#x") == "https://cdn.example.com/a.png"
    assert strip_url_key("") == ""
