from __future__ import annotations

from app.core.models import MediaCandidate, MediaType, SourceKind


def score_candidate(c: MediaCandidate) -> float:
    s = 0.0
    edge = c.min_edge
    if edge:
        s += min(edge / 2000.0, 0.45)
    if c.bytes_hint:
        s += min(c.bytes_hint / (8 * 1024 * 1024), 0.25)
    if c.media_type == MediaType.VIDEO:
        s += 0.15
    elif c.media_type == MediaType.GIF:
        s += 0.08
    if c.source_kind in (SourceKind.NETWORK, SourceKind.EXTENSION):
        s += 0.2
    elif c.source_kind == SourceKind.CACHE:
        s += 0.12
    elif c.source_kind == SourceKind.SCREENSHOT:
        s += 0.05
    if c.filtered_out:
        s -= 0.5
    c.score = round(max(0.0, s), 4)
    return c.score


def sort_candidates(cands: list[MediaCandidate], mode: str = "recommend") -> list[MediaCandidate]:
    if mode == "largest":
        return sorted(cands, key=lambda c: (c.bytes_hint or 0, c.min_edge or 0), reverse=True)
    if mode == "newest":
        return sorted(cands, key=lambda c: c.captured_at, reverse=True)
    # recommend
    for c in cands:
        score_candidate(c)
    return sorted(cands, key=lambda c: c.score, reverse=True)
