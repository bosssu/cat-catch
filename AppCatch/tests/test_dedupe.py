from __future__ import annotations

from pathlib import Path

from app.core.dedupe import dedupe_candidates, file_sha256
from app.core.models import MediaCandidate, MediaType, SourceKind


def test_url_dedupe_strips_query():
    a = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url="https://cdn.example.com/a.png?size=large",
    )
    b = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url="https://cdn.example.com/a.png?size=small",
    )
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url="https://cdn.example.com/b.png",
    )
    out = dedupe_candidates([a, b, c])
    assert len(out) == 2
    assert out[0].source_url.startswith("https://cdn.example.com/a.png")
    assert out[1].source_url == "https://cdn.example.com/b.png"


def test_file_hash_dedupe(tmp_path: Path):
    f1 = tmp_path / "one.bin"
    f2 = tmp_path / "two.bin"
    f3 = tmp_path / "three.bin"
    payload = b"identical-payload-for-hash"
    f1.write_bytes(payload)
    f2.write_bytes(payload)
    f3.write_bytes(b"different-content")

    c1 = MediaCandidate(media_type=MediaType.IMAGE, source_kind=SourceKind.FILE, local_path=str(f1))
    c2 = MediaCandidate(media_type=MediaType.IMAGE, source_kind=SourceKind.FILE, local_path=str(f2))
    c3 = MediaCandidate(media_type=MediaType.IMAGE, source_kind=SourceKind.FILE, local_path=str(f3))
    out = dedupe_candidates([c1, c2, c3])
    assert len(out) == 2
    assert out[0].local_path == str(f1)
    assert out[1].local_path == str(f3)
    assert "sha256_prefix" in out[0].meta


def test_file_sha256_stable(tmp_path: Path):
    p = tmp_path / "x.dat"
    p.write_bytes(b"abc" * 100)
    assert file_sha256(p) == file_sha256(p)
    assert len(file_sha256(p)) == 64
