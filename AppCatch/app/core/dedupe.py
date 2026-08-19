from __future__ import annotations

import hashlib
from pathlib import Path

from app.core.models import MediaCandidate


def file_sha256(path: str | Path, limit: int = 2 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        remaining = limit
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def dedupe_candidates(cands: list[MediaCandidate]) -> list[MediaCandidate]:
    seen_url: set[str] = set()
    seen_hash: set[str] = set()
    out: list[MediaCandidate] = []
    for c in cands:
        url = (c.source_url or "").strip()
        if url:
            key = url.split("?", 1)[0]
            if key in seen_url:
                continue
            seen_url.add(key)
        if c.local_path and Path(c.local_path).is_file():
            try:
                digest = file_sha256(c.local_path)
                if digest in seen_hash:
                    continue
                seen_hash.add(digest)
                c.meta.setdefault("sha256_prefix", digest)
            except OSError:
                pass
        out.append(c)
    return out
