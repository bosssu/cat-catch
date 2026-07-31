"""Byte-identical media: ingest gate + one-click cleanup."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import MediaItem
from app.services.util import content_hash_file


def hash_media_file(path: Path) -> tuple[str, int]:
    """Return (sha256_hex, size). Empty hash if missing/empty."""
    if not path.is_file():
        return "", 0
    try:
        size = int(path.stat().st_size)
    except OSError:
        return "", 0
    if size <= 0:
        return "", 0
    try:
        return content_hash_file(path), size
    except OSError:
        return "", size


def find_item_by_content(
    db: Session,
    content_hash: str,
    file_size: int,
    *,
    medias_root: Path | None = None,
    exclude_rel: str | None = None,
    exclude_id: int | None = None,
) -> MediaItem | None:
    """
    Find an existing MediaItem whose file bytes match ``content_hash``.

    1) Indexed ``content_hash`` column
    2) Same ``file_size`` rows with empty hash → hash on disk and backfill
    """
    if not content_hash or file_size <= 0:
        return None
    root = medias_root or get_settings().medias_path()

    def _ok(m: MediaItem) -> bool:
        if exclude_id is not None and int(m.id or 0) == int(exclude_id):
            return False
        if exclude_rel and (m.rel_path or "") == exclude_rel:
            return False
        return True

    for m in db.scalars(
        select(MediaItem).where(MediaItem.content_hash == content_hash)
    ).all():
        if _ok(m):
            return m

    # Legacy rows without content_hash: re-hash same-size candidates only
    candidates = list(
        db.scalars(
            select(MediaItem).where(MediaItem.file_size == int(file_size))
        ).all()
    )
    for m in candidates:
        if not _ok(m):
            continue
        stored = (getattr(m, "content_hash", None) or "").strip()
        if stored:
            if stored == content_hash:
                return m
            continue
        path = root / (m.rel_path or "")
        h, sz = hash_media_file(path)
        if not h:
            continue
        m.content_hash = h
        if sz and not m.file_size:
            m.file_size = sz
        if h == content_hash:
            return m
    return None


@dataclass
class DedupeGroup:
    content_hash: str
    file_size: int
    keep_id: int
    remove_ids: list[int] = field(default_factory=list)


@dataclass
class DedupeResult:
    scanned: int = 0
    groups: list[DedupeGroup] = field(default_factory=list)
    deleted_ids: list[int] = field(default_factory=list)
    kept_ids: list[int] = field(default_factory=list)
    skipped_missing: int = 0
    dry_run: bool = False

    def as_dict(self) -> dict:
        return {
            "dry_run": self.dry_run,
            "scanned": self.scanned,
            "duplicate_groups": len(self.groups),
            "would_delete": len(self.deleted_ids) if self.dry_run else 0,
            "deleted": 0 if self.dry_run else len(self.deleted_ids),
            "deleted_ids": list(self.deleted_ids),
            "kept_ids": list(self.kept_ids),
            "skipped_missing": self.skipped_missing,
            "groups": [
                {
                    "content_hash": g.content_hash,
                    "file_size": g.file_size,
                    "keep_id": g.keep_id,
                    "remove_ids": list(g.remove_ids),
                }
                for g in self.groups
            ],
        }


def _keep_rank(m: MediaItem) -> tuple:
    """Higher is better. Prefer liked / engagement / review, then older id."""
    review = (getattr(m, "review", None) or "").strip()
    return (
        1 if getattr(m, "liked", False) else 0,
        int(getattr(m, "like_count", 0) or 0),
        1 if review else 0,
        int(getattr(m, "view_count", 0) or 0),
        int(getattr(m, "dwell_ms_total", 0) or 0),
        # older (smaller id) wins ties
        -int(m.id or 0),
    )


def find_identical_groups(db: Session, medias_root: Path | None = None) -> tuple[list[DedupeGroup], int, int]:
    """
    Find groups of MediaItem rows whose on-disk files are byte-identical.

    Strategy: bucket by file_size, then SHA-256 content hash within each bucket.
    Only size>=1 and existing files participate.
    """
    root = medias_root or get_settings().medias_path()
    items: list[MediaItem] = list(db.scalars(select(MediaItem)).all())
    scanned = len(items)
    skipped_missing = 0

    by_size: dict[int, list[MediaItem]] = defaultdict(list)
    for m in items:
        size = int(m.file_size or 0)
        path = root / (m.rel_path or "")
        if size <= 0 or not path.is_file():
            # refresh size from disk when DB says 0 but file exists
            if path.is_file():
                try:
                    size = int(path.stat().st_size)
                except OSError:
                    size = 0
            if size <= 0 or not path.is_file():
                skipped_missing += 1
                continue
            if not m.file_size:
                m.file_size = size
        by_size[size].append(m)

    groups: list[DedupeGroup] = []
    for size, bucket in by_size.items():
        if len(bucket) < 2:
            continue
        by_hash: dict[str, list[MediaItem]] = defaultdict(list)
        for m in bucket:
            h = (getattr(m, "content_hash", None) or "").strip()
            if not h:
                path = root / (m.rel_path or "")
                h, _sz = hash_media_file(path)
                if not h:
                    skipped_missing += 1
                    continue
                m.content_hash = h
            by_hash[h].append(m)
        for h, dups in by_hash.items():
            if len(dups) < 2:
                continue
            ranked = sorted(dups, key=_keep_rank, reverse=True)
            keep = ranked[0]
            remove = ranked[1:]
            groups.append(
                DedupeGroup(
                    content_hash=h,
                    file_size=size,
                    keep_id=int(keep.id),
                    remove_ids=[int(x.id) for x in remove],
                )
            )
    return groups, scanned, skipped_missing


def dedupe_identical_media(
    db: Session,
    *,
    dry_run: bool = False,
    delete_row,
) -> DedupeResult:
    """
    Remove duplicate MediaItem rows that point at byte-identical video/media files.

    ``delete_row(db, media)`` must remove file + thumb + DB row (no commit).
    """
    groups, scanned, skipped = find_identical_groups(db)
    result = DedupeResult(
        scanned=scanned,
        groups=groups,
        dry_run=dry_run,
        skipped_missing=skipped,
    )
    for g in groups:
        result.kept_ids.append(g.keep_id)
        result.deleted_ids.extend(g.remove_ids)

    if dry_run or not result.deleted_ids:
        return result

    for mid in list(result.deleted_ids):
        m = db.get(MediaItem, mid)
        if not m:
            continue
        delete_row(db, m)
    db.commit()
    return result
