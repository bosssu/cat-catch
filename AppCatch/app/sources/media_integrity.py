"""Detect truncated / unplayable media (esp. Discord Cache_Data partial MP4)."""

from __future__ import annotations

import struct
from pathlib import Path


def is_media_complete(path: str | Path) -> tuple[bool, str]:
    """
    Return (ok, reason).
    Incomplete Discord cache often has mdat box size >> file size → only ~1s plays.

    IMPORTANT: never read the whole file into memory (large downloads would freeze UI).
    """
    p = Path(path)
    try:
        size = p.stat().st_size
        with p.open("rb") as f:
            head = f.read(min(64, size))
    except OSError as e:
        return False, str(e)
    if size < 32:
        return False, "文件过小"

    # ISO BMFF / MP4 / M4V / MOV
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return _check_bmff_stream(p, size)

    # WebM / Matroska EBML
    if head[:4] == b"\x1a\x45\xdf\xa3":
        if size < 50_000:
            return False, "WebM 过小，可能是缓存分片"
        return True, "ok"

    # RIFF (AVI / WEBP / WAVE)
    if head[:4] == b"RIFF" and len(head) >= 12:
        declared = struct.unpack_from("<I", head, 4)[0] + 8
        if declared > size + 8:
            return False, f"RIFF 声明 {declared} 字节，实际仅 {size}"
        return True, "ok"

    if head[:3] == b"\xff\xd8\xff" or head[:4] == b"\x89PNG" or head[:3] == b"GIF":
        return True, "ok"

    return True, "ok"


def _check_bmff_stream(path: Path, file_size: int) -> tuple[bool, str]:
    """Walk top-level boxes via seek; only read 16-byte headers."""
    types: set[str] = set()
    mdat_total = 0
    i = 0
    max_boxes = 64
    try:
        with path.open("rb") as f:
            for _ in range(max_boxes):
                if i + 8 > file_size:
                    break
                f.seek(i)
                hdr = f.read(16)
                if len(hdr) < 8:
                    return False, "box 头被截断"
                size32 = struct.unpack_from(">I", hdr, 0)[0]
                typ = hdr[4:8]
                try:
                    tname = typ.decode("ascii")
                except Exception:
                    tname = typ.hex()

                if size32 == 1:
                    if len(hdr) < 16:
                        return False, "box 头被截断"
                    size = struct.unpack_from(">Q", hdr, 8)[0]
                    hdr_len = 16
                elif size32 == 0:
                    size = file_size - i
                    hdr_len = 8
                else:
                    size = size32
                    hdr_len = 8

                if size < hdr_len:
                    return False, f"非法 box 大小 {size}"

                end = i + size
                if end > file_size:
                    return (
                        False,
                        f"分片不完整：{tname} 需要到 {end} 字节，文件只有 {file_size}（差 {end - file_size}）",
                    )

                types.add(tname)
                if tname == "mdat":
                    mdat_total += size
                i = end
                if i >= file_size:
                    break
    except OSError as e:
        return False, str(e)

    if "ftyp" not in types:
        return False, "缺少 ftyp"
    if "moov" not in types and "moof" not in types:
        return False, "缺少 moov（无法独立播放）"
    if mdat_total == 0 and "moov" in types:
        return False, "仅有元数据无媒体数据"
    return True, "ok"


def annotate_candidate_integrity(cand) -> bool:
    """
    Set cand.meta['media_complete'] and incomplete reason.
    Returns True if complete (or non-local / non-checkable as complete).
    """
    path = getattr(cand, "local_path", None)
    if not path:
        cand.meta["media_complete"] = True
        return True
    p = Path(path)
    if not p.is_file():
        cand.meta["media_complete"] = False
        cand.meta["incomplete_reason"] = "本地文件不存在"
        return False
    # cache result on meta to avoid re-scanning large files
    if "media_complete" in cand.meta and cand.meta.get("_integrity_path") == str(p):
        return bool(cand.meta["media_complete"])
    ok, reason = is_media_complete(p)
    cand.meta["media_complete"] = ok
    cand.meta["_integrity_path"] = str(p)
    if not ok:
        cand.meta["incomplete_reason"] = reason
        try:
            cand.score = min(float(cand.score or 0), 0.15)
        except Exception:
            pass
    return ok
