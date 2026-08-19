from __future__ import annotations

import struct
from pathlib import Path

from app.sources.media_integrity import is_media_complete


def _box(typ: bytes, payload: bytes) -> bytes:
    size = 8 + len(payload)
    return struct.pack(">I", size) + typ + payload


def test_complete_mp4_minimal(tmp_path: Path):
    # ftyp + moov + small mdat that fits
    ftyp = _box(b"ftyp", b"isom\x00\x00\x00\x00isom")
    moov = _box(b"moov", b"\x00" * 32)
    mdat = _box(b"mdat", b"\x00" * 64)
    p = tmp_path / "ok.mp4"
    p.write_bytes(ftyp + moov + mdat)
    ok, reason = is_media_complete(p)
    assert ok, reason


def test_truncated_mdat_like_discord_cache(tmp_path: Path):
    """mdat declares huge size but file ends early — Discord Cache_Data case."""
    ftyp = _box(b"ftyp", b"M4V \x00\x00\x00\x01isomavc1mp42")
    moov = _box(b"moov", b"\x00" * 100)
    # fake mdat header claiming 10MB body
    mdat_hdr = struct.pack(">I", 8 + 10_000_000) + b"mdat"
    p = tmp_path / "f_trunc"
    p.write_bytes(ftyp + moov + mdat_hdr + b"\x00" * 200)
    ok, reason = is_media_complete(p)
    assert not ok
    assert "不完整" in reason or "分片" in reason


def test_real_discord_cache_if_present():
    p = Path(r"C:/Users/bosssu/AppData/Roaming/Discord/Cache/Cache_Data/f_000958")
    if not p.is_file():
        return
    ok, reason = is_media_complete(p)
    assert not ok, f"expected incomplete, got ok reason={reason}"
