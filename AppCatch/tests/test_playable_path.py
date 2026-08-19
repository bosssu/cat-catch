from __future__ import annotations

from pathlib import Path

from app.sources.playable_path import ensure_playable_path


def test_ensure_playable_adds_mp4_ext(tmp_path: Path, monkeypatch):
    # minimal ftyp box
    raw = tmp_path / "f_deadbeef"
    # size(4) + ftyp + isom
    payload = b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isomiso2"
    raw.write_bytes(payload + b"\x00" * 64)

    # redirect playable dir into tmp
    import app.sources.playable_path as pp

    monkeypatch.setattr(pp, "_PLAY_DIR", tmp_path / "playable")

    out = ensure_playable_path(raw)
    assert out is not None
    assert out.suffix.lower() == ".mp4"
    assert out.is_file()
    assert out.read_bytes()[:12] == raw.read_bytes()[:12]


def test_ensure_playable_keeps_existing_ext(tmp_path: Path):
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00" + b"\x00" * 32)
    assert ensure_playable_path(f) == f
