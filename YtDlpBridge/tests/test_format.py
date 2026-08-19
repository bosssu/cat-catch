from app.format import ios_format_selector, is_ios_playable, ytdlp_base_args
from app.jobs import parse_progress_line


def test_ios_format_prefers_avc():
    sel = ios_format_selector(1080)
    assert "avc1" in sel
    assert "mp4a" in sel
    assert "height<=1080" in sel


def test_ytdlp_args_merge_mp4():
    args = ytdlp_base_args(max_height=720)
    assert "--merge-output-format" in args
    assert "mp4" in args
    assert "-S" in args
    assert "--ppa" in args
    assert "ffmpeg:-movflags +faststart" in args
    assert "--socket-timeout" in args
    assert "--retries" in args
    args_ck = ytdlp_base_args(cookies_from_browser="chrome", deno=None)
    assert "--cookies-from-browser" in args_ck
    assert "chrome" in args_ck
    args_file = ytdlp_base_args(cookies_file="c.txt", cookies_from_browser="chrome", deno=None)
    assert "--cookies" in args_file
    assert "--cookies-from-browser" not in args_file
    assert "--extractor-args" in args_file
    assert "youtube:player_client=default,web_embedded" in args_file
    args_js = ytdlp_base_args(deno=r"C:\deno.exe")
    assert "--js-runtimes" in args_js
    assert r"deno:C:\deno.exe" in args_js
    args_px = ytdlp_base_args(proxy="http://127.0.0.1:7890", deno=None)
    assert "--proxy" in args_px
    assert "http://127.0.0.1:7890" in args_px


def test_ios_playable():
    assert is_ios_playable({"video": "h264", "audio": "aac", "ext": "mp4"})
    assert is_ios_playable({"video": "avc1", "audio": "mp4a", "ext": "mp4"})
    assert not is_ios_playable({"video": "vp9", "audio": "opus", "ext": "webm"})
    assert not is_ios_playable({"video": "av1", "audio": "aac", "ext": "mp4"})


def test_parse_progress():
    assert parse_progress_line("[download]  12.3% of 10.00MiB") == 12.3
    assert parse_progress_line("no pct") is None
    assert parse_progress_line("[download] 100%") == 100.0
