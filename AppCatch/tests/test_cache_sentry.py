from __future__ import annotations

import time
from pathlib import Path

from app.sources.cache_sentry import CacheSentry, sniff_media
from app.sources.folder_watch import FolderWatch


def test_sniff_png(tmp_path: Path):
    p = tmp_path / "x.bin"
    # minimal PNG header
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    mt, mime = sniff_media(p)
    assert mt is not None
    assert "png" in (mime or "")


def test_collect_recent_file(tmp_path: Path, monkeypatch):
    # plant a png under a fake TEMP
    img = tmp_path / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20_000)
    sentry = CacheSentry(extra_roots=[str(tmp_path)])
    got = sentry.collect_for_process("AnyApp.exe", None, newer_than_sec=3600, limit=10, min_bytes=100)
    assert any(c.local_path and Path(c.local_path).name == "shot.png" for c in got)


def test_foreign_profile_path_generic():
    """Path under Discord profile is foreign to an unrelated process — no app whitelist needed."""
    from app.sources.cache_sentry import CacheSentry

    discord_file = Path(r"C:\Users\x\AppData\Roaming\discord\Cache_Data\f_abc")
    assert CacheSentry._foreign_app_path(discord_file, "Steam.exe") is True
    assert CacheSentry._foreign_app_path(discord_file, "Discord.exe") is False
    # brand-new process name still works (not foreign to itself)
    my = Path(r"C:\Users\x\AppData\Local\MyCoolApp\Cache\x.png")
    assert CacheSentry._foreign_app_path(my, "MyCoolApp.exe") is False
    assert CacheSentry._foreign_app_path(my, "OtherThing.exe") is True


def test_process_tokens_any_exe():
    from app.sources.cache_sentry import _process_tokens, _folder_matches_process

    toks = _process_tokens("MyCoolApp.exe")
    assert "mycoolapp" in toks
    assert _folder_matches_process("MyCoolApp", toks)
    assert _folder_matches_process("MyCoolApp-Cache", toks)


def test_folder_watch_drain(tmp_path: Path):
    fw = FolderWatch(dirs=[str(tmp_path)], include_downloads=False)
    # bootstrap
    fw.bootstrap()
    f = tmp_path / "new.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 12_000)
    # ensure mtime is now
    time.sleep(0.05)
    Path(f).touch()
    cands = fw.drain_new(process_name="Test.exe", pid=1, newer_than_sec=60)
    assert any(c.local_path and "new.png" in c.local_path for c in cands)
