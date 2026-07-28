from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import session_scope
from app.models.entities import MediaItem
from app.services.thumb import generate_thumb
from app.services.util import safe_category, url_hash

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov", ".ts", ".m4v"}


def rescan_medias() -> dict:
    settings = get_settings()
    root = settings.medias_path()
    added = 0
    skipped = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        parts = Path(rel).parts
        cat = safe_category(parts[0] if len(parts) > 1 else "default")
        if len(parts) == 1:
            # file directly under Medias — treat as default
            cat = "default"
            rel = f"default/{path.name}"
            dest = settings.medias_path() / "default" / path.name
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.replace(dest)
                path = dest
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
                category=cat,
                title=path.stem,
                media_type=mtype,
                rel_path=rel,
                source_url="",
                url_hash=url_hash(rel, cat),
                file_size=path.stat().st_size,
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
    return {"added": added, "skipped": skipped}


def list_categories() -> list[str]:
    settings = get_settings()
    cats = set()
    root = settings.medias_path()
    if root.is_dir():
        for p in root.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                cats.add(p.name)
    with session_scope() as db:
        for row in db.scalars(select(MediaItem.category).distinct()).all():
            if row:
                cats.add(row)
    if not cats:
        cats.add("default")
    return sorted(cats)


def ensure_category(name: str) -> str:
    cat = safe_category(name)
    (get_settings().medias_path() / cat).mkdir(parents=True, exist_ok=True)
    return cat
