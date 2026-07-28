from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import MediaItem
from app.services.thumb import generate_thumb
from app.services.util import url_hash

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".ts", ".m4v"}


def purge_missing_media() -> dict:
    """
    Drop DB rows whose files were deleted, fix stale sizes, remove orphan thumbs.
    """
    settings = get_settings()
    root = settings.medias_path()
    thumbs_root = settings.data_path() / "thumbs"
    purged = 0
    fixed_size = 0
    with session_scope() as db:
        rows = list(db.scalars(select(MediaItem)).all())
        for item in rows:
            path = root / item.rel_path
            if not path.is_file():
                if item.thumb_rel:
                    tp = settings.data_path() / item.thumb_rel
                    try:
                        if tp.is_file():
                            tp.unlink()
                    except OSError:
                        pass
                db.delete(item)
                purged += 1
                continue
            try:
                sz = path.stat().st_size
                if item.file_size != sz:
                    item.file_size = sz
                    fixed_size += 1
            except OSError:
                pass
        db.commit()

    orphan_thumbs = 0
    if thumbs_root.is_dir():
        with session_scope() as db:
            alive = {m.id for m in db.scalars(select(MediaItem)).all()}
        for p in thumbs_root.glob("*"):
            if not p.is_file():
                continue
            try:
                mid = int(p.stem.split(".")[0])
            except ValueError:
                continue
            if mid not in alive:
                try:
                    p.unlink()
                    orphan_thumbs += 1
                except OSError:
                    pass
    return {"purged": purged, "fixed_size": fixed_size, "orphan_thumbs": orphan_thumbs}


def rescan_medias(*, purge: bool = False) -> dict:
    """
    Index files under Medias/. Supports flat layout and legacy category subdirs.
    """
    settings = get_settings()
    root = settings.medias_path()
    purge_info = purge_missing_media() if purge else {"purged": 0, "fixed_size": 0, "orphan_thumbs": 0}
    added = 0
    skipped = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        # skip thumbs if ever nested
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if rel.startswith("."):
            continue
        ext = path.suffix.lower()
        if ext in IMAGE_EXT:
            mtype = "gif" if ext == ".gif" else "image"
        elif ext in VIDEO_EXT:
            mtype = "video"
        else:
            skipped += 1
            continue
        with session_scope() as db:
            exists = db.scalars(select(MediaItem).where(MediaItem.rel_path == rel)).first()
            if exists:
                skipped += 1
                continue
            item = MediaItem(
                category="default",
                title=path.stem,
                media_type=mtype,
                rel_path=rel,
                source_url="",
                url_hash=url_hash(rel, "default"),
                file_size=path.stat().st_size,
                tags_json="[]",
            )
            db.add(item)
            db.commit()
            db.refresh(item)
            mid = item.id
            mtype_s = mtype
        thumb = generate_thumb(path, mid, mtype_s)
        if thumb:
            with session_scope() as db:
                it = db.get(MediaItem, mid)
                if it:
                    it.thumb_rel = thumb
                    db.commit()
        added += 1
    return {"added": added, "skipped": skipped, **purge_info}


def list_categories() -> list[str]:
    """Deprecated: always return default for old clients."""
    return ["default"]


def ensure_category(name: str) -> str:
    """Deprecated: ensure Medias root exists; ignore name folders."""
    get_settings().medias_path().mkdir(parents=True, exist_ok=True)
    return "default"
