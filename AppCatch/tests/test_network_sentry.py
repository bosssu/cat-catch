from __future__ import annotations

from app.core.models import MediaType
from app.sources.network_inbox import append_inbox_line, ensure_inbox_file, feed_sentry_from_obj, parse_inbox_line
from app.sources.network_sentry import NetworkSentry, guess_media_type, parse_discord_dimensions


def test_guess_media_type():
    assert guess_media_type("https://x.com/a.png") == MediaType.IMAGE
    assert guess_media_type("https://x.com/a.gif") == MediaType.GIF
    assert guess_media_type("https://x.com/a.mp4") == MediaType.VIDEO
    assert guess_media_type("x", mime="audio/mpeg") == MediaType.AUDIO


def test_parse_discord_dimensions():
    w, h = parse_discord_dimensions("https://cdn.discordapp.com/x.png?width=1280&height=720")
    assert w == 1280 and h == 720


def test_observe_and_query():
    s = NetworkSentry()
    c = s.observe(
        "https://cdn.discordapp.com/attachments/1/2/photo.png",
        pid=42,
        process_name="Discord.exe",
    )
    assert c is not None
    assert len(s.candidates_for_pid(42)) == 1
    assert len(s.candidates_for_process("Discord.exe")) == 1
    # dedupe
    s.observe(
        "https://cdn.discordapp.com/attachments/1/2/photo.png",
        pid=42,
        process_name="Discord.exe",
    )
    assert len(s.candidates_for_pid(42)) == 1


def test_claim_hook_filters():
    s = NetworkSentry()

    def hook(url, **kw):
        if "avatar" in url:
            return []
        from app.core.models import MediaCandidate, SourceKind

        return [
            MediaCandidate(
                source_kind=SourceKind.NETWORK,
                source_url=url,
                extension_id="test",
                process_name=kw.get("process_name") or "",
                pid=kw.get("pid"),
            )
        ]

    s.set_claim_hook(hook)
    assert s.observe("https://cdn.discordapp.com/avatars/1.png", pid=1) is None
    assert s.observe("https://cdn.discordapp.com/attachments/1/2/a.png", pid=1) is not None


def test_inbox_parse_and_feed(tmp_path):
    line = '{"url":"https://example.com/a.jpg","pid":9,"process_name":"App.exe","mime":"image/jpeg"}'
    obj = parse_inbox_line(line)
    assert obj and obj["url"].endswith(".jpg")
    s = NetworkSentry()
    feed_sentry_from_obj(s, obj)
    assert s.candidates_for_pid(9)

    path = tmp_path / "inbox.jsonl"
    ensure_inbox_file(path)
    append_inbox_line(
        {"url": "https://example.com/b.mp4", "pid": 3, "process_name": "X.exe"},
        path=path,
    )
    assert path.read_text(encoding="utf-8").strip()
