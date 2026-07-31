"""Quick smoke test for audio classification and AV merge helpers."""
from pathlib import Path
import tempfile, os

from app.services.media_process import (
    sniff_image_kind,
    classify_media_file,
    duration_match_score,
    match_av_by_duration,
)


def test_sniff_image_kind():
    tmp = Path(tempfile.mktemp(suffix=".mp4"))
    tmp.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)
    kind = sniff_image_kind(tmp)
    assert kind == "image", f"Expected image, got {kind}"
    os.unlink(tmp)
    print("ok sniff_image_kind: JPEG as .mp4 → image")


def test_classify_empty():
    tmp = Path(tempfile.mktemp(suffix=".bin"))
    tmp.write_bytes(b"")
    cls = classify_media_file(tmp, hinted="video")
    print(f"  empty → {cls['media_type']} error={cls['error']}")
    assert cls["media_type"] == "video", str(cls)
    os.unlink(tmp)


def test_classify_missing():
    cls = classify_media_file(Path("NONEXISTENT_FILE.xyz"), hinted="video")
    print(f"  missing → {cls['media_type']} error={cls['error']}")
    assert cls["media_type"] == "video", str(cls)
    assert cls["error"] == "missing", str(cls)


def test_classify_png_magic():
    tmp = Path(tempfile.mktemp(suffix=".bin"))
    tmp.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
    cls = classify_media_file(tmp, hinted="video", content_type="video/mp4")
    print(f"  PNG as .bin → {cls['media_type']} method={cls['method']}")
    assert cls["media_type"] == "image", str(cls)
    assert cls["method"] == "magic", str(cls)
    os.unlink(tmp)


def test_duration_match():
    s1 = duration_match_score(10.0, 10.1)
    s2 = duration_match_score(10.0, 12.0)
    s3 = duration_match_score(None, 10.0)
    print(f"  duration: 10vs10.1={s1} 10vs12={s2} None={s3}")
    assert s1 is not None and s1 > 0.9, f"close durations should match, got {s1}"
    assert s2 is None, f"far durations should not match, got {s2}"
    assert s3 is None, f"None durations should not match, got {s3}"


def test_match_av_by_duration():
    videos = [
        {"id": 1, "duration_sec": 60.0, "title": "v1"},
        {"id": 2, "duration_sec": 120.0, "title": "v2"},
    ]
    audios = [
        {"id": 10, "duration_sec": 60.05, "title": "a1"},
        {"id": 11, "duration_sec": 119.9, "title": "a2"},
    ]
    pairs = match_av_by_duration(videos, audios)
    print(f"  pairs: {len(pairs)} → {pairs}")
    assert len(pairs) == 2, f"Expected 2 pairs, got {len(pairs)}"
    assert {p["video_id"] for p in pairs} == {1, 2}


if __name__ == "__main__":
    import sys
    tests = [
        n for n in dir() if n.startswith("test_")
    ]
    for name in tests:
        print(f"[{name}]")
        try:
            globals()[name]()
        except Exception as e:
            print(f"  FAIL: {e}")
            sys.exit(1)
    print("\nAll audio/av tests passed!")
