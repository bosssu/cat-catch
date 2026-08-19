from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from app.core.config import AppConfig
from app.core.models import MediaCandidate, MediaType, SourceKind
from app.sources.cache_sentry import expand_env_path, sniff_media, _try_image_size

_MEDIA_EXTS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".mp4",
    ".webm",
    ".mkv",
    ".mov",
    ".m4v",
}


def default_downloads() -> Path | None:
    home = Path.home()
    for name in ("Downloads", "下载"):
        p = home / name
        if p.is_dir():
            return p
    dl = expand_env_path(r"%USERPROFILE%\Downloads")
    if dl.is_dir():
        return dl
    return None


def _guess_from_ext(ext: str) -> tuple[MediaType | None, str | None]:
    if ext in (".jpg", ".jpeg"):
        return MediaType.IMAGE, "image/jpeg"
    if ext == ".png":
        return MediaType.IMAGE, "image/png"
    if ext == ".gif":
        return MediaType.GIF, "image/gif"
    if ext == ".webp":
        return MediaType.IMAGE, "image/webp"
    if ext == ".bmp":
        return MediaType.IMAGE, "image/bmp"
    if ext in (".mp4", ".m4v", ".mov"):
        return MediaType.VIDEO, "video/mp4"
    if ext == ".webm":
        return MediaType.VIDEO, "video/webm"
    if ext == ".mkv":
        return MediaType.VIDEO, "video/x-matroska"
    return None, None


class FolderWatch:
    """
    Lightweight mtime-based folder poller (no watchdog dependency).
    Tracks seen paths and returns new/changed media as MediaCandidate.
    """

    def __init__(
        self,
        dirs: list[str | Path] | None = None,
        cfg: AppConfig | None = None,
        *,
        include_downloads: bool = True,
        min_bytes: int | None = None,
    ):
        self.cfg = cfg
        raw_dirs: list[Any] = list(dirs or [])
        if cfg is not None:
            raw_dirs.extend(cfg.get("watch_dirs", default=[]) or [])
            if min_bytes is None:
                min_bytes = int(cfg.get("capture", "min_bytes", default=8192) or 8192)
        self.min_bytes = int(min_bytes if min_bytes is not None else 8192)

        roots: list[Path] = []
        for d in raw_dirs:
            try:
                p = expand_env_path(str(d)) if not isinstance(d, Path) else d
            except Exception:
                continue
            if p.is_dir():
                roots.append(p)
        if include_downloads:
            dl = default_downloads()
            if dl is not None:
                roots.append(dl)

        seen_keys: set[str] = set()
        self.dirs: list[Path] = []
        for p in roots:
            try:
                key = str(p.resolve()).lower()
            except OSError:
                key = str(p).lower()
            if key in seen_keys:
                continue
            seen_keys.add(key)
            self.dirs.append(p)

        # path -> (mtime, size)
        self._seen: dict[str, tuple[float, int]] = {}
        self._bootstrapped = False

    def bootstrap(self) -> None:
        """Mark current files as seen without reporting them."""
        for path, mtime, size in self._iter_media_files():
            self._seen[str(path)] = (mtime, size)
        self._bootstrapped = True

    def poll_new_files(self, since_ts: float | None = None) -> list[Path]:
        """Return paths newer than since_ts (or all media if None) under watch dirs."""
        out: list[Path] = []
        for path, mtime, size in self._iter_media_files():
            if size < self.min_bytes:
                continue
            if since_ts is not None and mtime < since_ts:
                continue
            out.append(path)
        out.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        return out

    def drain_new(
        self,
        *,
        process_name: str = "",
        pid: int | None = None,
        limit: int = 40,
        newer_than_sec: float | None = 600,
    ) -> list[MediaCandidate]:
        """
        Return candidates for files not yet seen (or size/mtime changed).
        First call bootstraps and only returns files within newer_than_sec if set.
        """
        if not self._bootstrapped:
            cutoff = time.time() - newer_than_sec if newer_than_sec else None
            fresh: list[tuple[Path, float, int]] = []
            for path, mtime, size in self._iter_media_files():
                key = str(path)
                self._seen[key] = (mtime, size)
                if size < self.min_bytes:
                    continue
                if cutoff is not None and mtime < cutoff:
                    continue
                fresh.append((path, mtime, size))
            self._bootstrapped = True
            fresh.sort(key=lambda x: x[1], reverse=True)
            return [
                self._to_candidate(p, mtime, size, process_name, pid)
                for p, mtime, size in fresh[:limit]
            ]

        new_items: list[tuple[Path, float, int]] = []
        for path, mtime, size in self._iter_media_files():
            if size < self.min_bytes:
                continue
            key = str(path)
            prev = self._seen.get(key)
            if prev is not None and prev[0] == mtime and prev[1] == size:
                continue
            self._seen[key] = (mtime, size)
            if newer_than_sec is not None and mtime < time.time() - newer_than_sec:
                continue
            new_items.append((path, mtime, size))
        new_items.sort(key=lambda x: x[1], reverse=True)
        return [
            self._to_candidate(p, mtime, size, process_name, pid)
            for p, mtime, size in new_items[:limit]
        ]

    def _iter_media_files(self, max_depth: int = 2):
        for root in self.dirs:
            root_depth = len(root.parts)
            try:
                for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
                    pdir = Path(dirpath)
                    if len(pdir.parts) - root_depth > max_depth:
                        dirnames.clear()
                        continue
                    for name in filenames:
                        fp = pdir / name
                        try:
                            st = fp.stat()
                        except OSError:
                            continue
                        ext = fp.suffix.lower()
                        if ext in _MEDIA_EXTS:
                            yield fp, st.st_mtime, st.st_size
                            continue
                        # extension-less or odd: try magic
                        if not ext or len(ext) > 6:
                            if sniff_media(fp):
                                yield fp, st.st_mtime, st.st_size
            except OSError:
                continue

    def _to_candidate(
        self,
        path: Path,
        mtime: float,
        size: int,
        process_name: str,
        pid: int | None,
    ) -> MediaCandidate:
        sniffed = sniff_media(path)
        if sniffed:
            mtype, mime = sniffed
        else:
            guessed = _guess_from_ext(path.suffix.lower())
            mtype = guessed[0] or MediaType.IMAGE
            mime = guessed[1] or "application/octet-stream"
        w, h = (None, None)
        if mtype in (MediaType.IMAGE, MediaType.GIF):
            w, h = _try_image_size(path)
        return MediaCandidate(
            media_type=mtype,
            source_kind=SourceKind.FILE,
            extension_id="builtin.folder_watch",
            process_name=process_name,
            pid=pid,
            title=path.name,
            source_url=f"appcatch://watch/{path.name}",
            local_path=str(path),
            bytes_hint=size,
            width=w,
            height=h,
            mime=mime,
            score=0.5,
            meta={"watch_dir": str(path.parent), "mtime": mtime},
        )
