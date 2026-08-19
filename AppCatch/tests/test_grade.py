from __future__ import annotations

from pathlib import Path

from app.core.grade import (
    CandidateGrade,
    apply_grades,
    grade_candidate,
    grade_label_zh,
    session_summary,
)
from app.core.models import MediaCandidate, MediaType, SourceKind


def test_grade_original_when_local_file_exists(tmp_path: Path):
    f = tmp_path / "a.png"
    f.write_bytes(b"x")
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.FILE,
        local_path=str(f),
    )
    assert grade_candidate(c) == CandidateGrade.ORIGINAL


def test_grade_link_when_http_no_local():
    c = MediaCandidate(
        media_type=MediaType.VIDEO,
        source_kind=SourceKind.NETWORK,
        source_url="https://example.com/v.mp4",
        local_path=None,
    )
    assert grade_candidate(c) == CandidateGrade.LINK


def test_grade_screenshot_kind():
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.SCREENSHOT,
        local_path=None,
        source_url="",
    )
    assert grade_candidate(c) == CandidateGrade.SCREENSHOT


def test_grade_screenshot_wins_even_with_local(tmp_path: Path):
    f = tmp_path / "shot.png"
    f.write_bytes(b"x")
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.SCREENSHOT,
        local_path=str(f),
    )
    assert grade_candidate(c) == CandidateGrade.SCREENSHOT


def test_grade_other_missing_local_and_no_url():
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.CACHE,
        local_path=r"C:\no\such\file_xyz.png",
        source_url="",
    )
    assert grade_candidate(c) == CandidateGrade.OTHER


def test_grade_link_when_local_missing_but_http_url():
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        local_path=r"C:\missing\file.png",
        source_url="https://cdn.example.com/a.jpg",
    )
    # local not a file → fall through to link
    assert grade_candidate(c) == CandidateGrade.LINK


def test_grade_label_zh():
    assert grade_label_zh(CandidateGrade.ORIGINAL) == "原片"
    assert grade_label_zh(CandidateGrade.LINK) == "链接"
    assert grade_label_zh(CandidateGrade.SCREENSHOT) == "截图"
    assert grade_label_zh(CandidateGrade.OTHER) == "其他"


def test_apply_grades_sets_meta(tmp_path: Path):
    # complete-enough local image as original
    f = tmp_path / "b.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40)
    cands = [
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.FILE,
            local_path=str(f),
        ),
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.NETWORK,
            source_url="https://x.test/i.png",
        ),
    ]
    apply_grades(cands)
    assert cands[0].meta["grade"] == "original"
    assert cands[1].meta["grade"] == "link"


def test_grade_fragment_incomplete_video(tmp_path: Path):
    import struct

    ftyp = struct.pack(">I", 24) + b"ftyp" + b"isom\x00\x00\x00\x00isom"
    moov = struct.pack(">I", 40) + b"moov" + b"\x00" * 32
    mdat_hdr = struct.pack(">I", 8 + 5_000_000) + b"mdat"
    p = tmp_path / "frag"
    p.write_bytes(ftyp + moov + mdat_hdr + b"\x00" * 50)
    c = MediaCandidate(
        media_type=MediaType.VIDEO,
        source_kind=SourceKind.CACHE,
        local_path=str(p),
    )
    assert grade_candidate(c) == CandidateGrade.FRAGMENT


def test_session_summary_counts_and_headline(tmp_path: Path):
    f = tmp_path / "o.jpg"
    f.write_bytes(b"1")
    cands = [
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.FILE,
            local_path=str(f),
        ),
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.NETWORK,
            source_url="https://a/b.jpg",
        ),
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.SCREENSHOT,
        ),
        MediaCandidate(
            media_type=MediaType.IMAGE,
            source_kind=SourceKind.DEMO,
            filtered_out=True,
        ),
    ]
    s = session_summary(cands)
    assert s["original"] == 1
    assert s["link"] == 1
    assert s["screenshot"] == 1
    assert s["other"] == 0
    assert s["visible"] == 3
    assert "原片" in s["headline"]
    assert "链接" in s["headline"]
    assert "截图" in s["headline"]
    assert "3" in s["headline"]


def test_session_summary_empty():
    s = session_summary([])
    assert s["visible"] == 0
    assert s["headline"] == "暂无候选"
