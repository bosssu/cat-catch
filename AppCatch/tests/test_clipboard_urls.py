from __future__ import annotations

from app.sources.clipboard_sentry import (
    ClipboardSentry,
    _candidates_from_text_urls,
    extract_media_urls,
    snapshot_clipboard_media,
)


def test_extract_media_urls():
    text = "see https://cdn.discordapp.com/attachments/1/2/a.png and http://x.com/b.mp4 end"
    urls = extract_media_urls(text)
    assert any(u.endswith(".png") for u in urls)
    assert any(u.endswith(".mp4") for u in urls)


def test_extract_youtube_and_bilibili():
    text = (
        "watch https://www.youtube.com/watch?v=dQw4w9WgXcQ "
        "or https://youtu.be/dQw4w9WgXcQ "
        "and https://www.bilibili.com/video/BV1xx411c7mD "
        "cdn https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/01/23/x.m4s"
    )
    urls = extract_media_urls(text)
    assert any("youtube.com" in u for u in urls)
    assert any("youtu.be" in u for u in urls)
    assert any("bilibili.com" in u for u in urls)
    assert any("bilivideo.com" in u for u in urls)


def test_extract_discord_attachment_without_ext():
    # signed / query-string attachment often has no path extension
    text = (
        "https://cdn.discordapp.com/attachments/111/222/file"
        "?ex=abcdef&is=123&hm=deadbeef "
        "https://media.discordapp.net/attachments/1/2/photo?width=800&height=600 "
        "https://discord.com/attachments/9/8/thing?ex=1"
    )
    urls = extract_media_urls(text)
    assert any("cdn.discordapp.com/attachments" in u for u in urls)
    assert any("media.discordapp.net" in u for u in urls)
    assert any("discord.com/attachments" in u for u in urls)


def test_extract_m3u8_and_imgur_twimg():
    text = (
        "https://example.com/stream/index.m3u8 "
        "https://i.imgur.com/abc123.jpg "
        "https://pbs.twimg.com/media/XYZ.jpg "
        "https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/x.mp4 "
        "https://tenor.com/view/cat-gif-123"
    )
    urls = extract_media_urls(text)
    assert any(u.endswith(".m3u8") for u in urls)
    assert any("i.imgur.com" in u for u in urls)
    assert any("pbs.twimg.com" in u for u in urls)
    assert any("video.twimg.com" in u for u in urls)
    assert any("tenor.com" in u for u in urls)


def test_candidates_from_text_urls_pure_path():
    text = "https://cdn.discordapp.com/attachments/1/2/x?ex=1&is=2"
    cands = _candidates_from_text_urls(
        process_name="clipboard",
        pid=None,
        remember=False,
        sentry=None,
        text=text,
    )
    assert len(cands) == 1
    assert cands[0].source_url.startswith("https://cdn.discordapp.com")
    assert cands[0].meta.get("clipboard") == "url"


def test_snapshot_remember_false_reemits_same_url():
    text = "https://i.imgur.com/abc.png"
    cands1 = _candidates_from_text_urls(
        process_name="clipboard",
        pid=None,
        remember=False,
        sentry=None,
        text=text,
    )
    cands2 = _candidates_from_text_urls(
        process_name="clipboard",
        pid=None,
        remember=False,
        sentry=None,
        text=text,
    )
    assert len(cands1) == 1 and len(cands2) == 1


def test_snapshot_remember_true_dedupes_with_sentry():
    sentry = ClipboardSentry()
    text = "https://i.imgur.com/abc.png"
    cands1 = _candidates_from_text_urls(
        process_name="clipboard",
        pid=None,
        remember=True,
        sentry=sentry,
        text=text,
    )
    cands2 = _candidates_from_text_urls(
        process_name="clipboard",
        pid=None,
        remember=True,
        sentry=sentry,
        text=text,
    )
    assert len(cands1) == 1
    assert len(cands2) == 0


def test_clipboard_sentry_snapshot_method_exists():
    s = ClipboardSentry(process_name="test-clip")
    # on non-win32 returns []; on win32 may read real clipboard — just ensure callable
    result = s.snapshot(remember=False)
    assert isinstance(result, list)
    # module-level entrypoint
    result2 = snapshot_clipboard_media(process_name="test-clip", remember=False)
    assert isinstance(result2, list)
