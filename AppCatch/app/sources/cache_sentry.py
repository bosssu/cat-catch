from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Iterable

from app.core.config import AppConfig
from app.core.models import MediaCandidate, MediaType, SourceKind
from app.sources.media_integrity import is_media_complete

# path segments to skip (case-insensitive substring match on full path)
_SKIP_SEGMENTS = ("gpucache", "code cache", "local storage", "service worker", "shadercache")

# Shared profile roots that are NOT an app owner (scan them, but don't use as foreign markers)
_SHARED_PROFILE_NAMES = frozenset(
    {
        "temp",
        "tmp",
        "microsoft",
        "packages",
        "programs",
        "elevateddiagnostics",
        "application data",
        "local",
        "roaming",
        "cache",
        "caches",
        "d3dscache",
        "iconcache.db",
        "nvidia",
        "intel",
        "amd",
        "crashdumps",
        "virtualstore",
    }
)

# Optional non-obvious path hints (process token → env paths).
# Generic discovery covers most apps; this is only for odd layouts.
_HINT_ROOTS: dict[str, tuple[str, ...]] = {
    "discord": (
        r"%APPDATA%\discord\Cache",
        r"%APPDATA%\discord\CachedData",
        r"%APPDATA%\discord\Cache_Data",
        r"%LOCALAPPDATA%\Discord",
        r"%APPDATA%\discord",
    ),
    "steam": (
        r"%LOCALAPPDATA%\Steam\htmlcache",
        r"%LOCALAPPDATA%\Steam\htmlcache\Cache",
        r"%LOCALAPPDATA%\Steam\appcache",
    ),
    "cloudmusic": (
        r"%LOCALAPPDATA%\NetEase\CloudMusic\Cache",
        r"%LOCALAPPDATA%\Netease\CloudMusic",
        r"%APPDATA%\NetEase\CloudMusic",
    ),
}

# magic signatures
_JPEG = b"\xff\xd8\xff"
_PNG = b"\x89PNG"
_GIF = b"GIF"
_WEBM = b"\x1a\x45\xdf\xa3"
_RIFF = b"RIFF"
_WEBP = b"WEBP"
_FTYP = b"ftyp"


def expand_env_path(s: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(s)))


def sniff_media(path: Path, head: bytes | None = None) -> tuple[MediaType, str] | None:
    """Identify media by magic bytes. Returns (MediaType, mime) or None.

    Never loads the whole file — only the first 32 bytes (or provided head).
    """
    try:
        if head is not None:
            data = head[:32]
        else:
            with path.open("rb") as f:
                data = f.read(32)
    except OSError:
        return None
    if len(data) < 12:
        return None
    if data[:3] == _JPEG:
        return MediaType.IMAGE, "image/jpeg"
    if data[:4] == _PNG:
        return MediaType.IMAGE, "image/png"
    if data[:3] == _GIF:
        return MediaType.GIF, "image/gif"
    if data[:4] == _RIFF and data[8:12] == _WEBP:
        return MediaType.IMAGE, "image/webp"
    if data[:4] == _WEBM:
        return MediaType.VIDEO, "video/webm"
    # ISO BMFF / MP4 family: ....ftyp
    if len(data) >= 12 and data[4:8] == _FTYP:
        return MediaType.VIDEO, "video/mp4"
    return None


def _path_skipped(p: Path) -> bool:
    s = str(p).lower().replace("/", "\\")
    return any(seg in s for seg in _SKIP_SEGMENTS)


def _try_image_size(path: Path) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(path) as im:
            return int(im.width), int(im.height)
    except Exception:
        return None, None


def _app_name(process_name: str) -> str:
    name = (process_name or "").strip()
    if name.lower().endswith(".exe"):
        name = name[:-4]
    return name


def _process_tokens(process_name: str) -> list[str]:
    """Tokens used to match profile folders for *any* process name."""
    app = _app_name(process_name).lower()
    if not app:
        return []
    tokens: list[str] = [app]
    # split FooBar / foo_bar / foo-bar
    parts = re.split(r"[^a-z0-9]+", app)
    tokens.extend(p for p in parts if len(p) >= 3)
    # long contiguous chunks (steamwebhelper → steam, webhelper already from split? no)
    for m in re.finditer(r"[a-z]{4,}", app):
        tokens.append(m.group(0))
    # de-dupe, prefer longer first for matching quality
    uniq = list(dict.fromkeys(t for t in tokens if t))
    uniq.sort(key=len, reverse=True)
    return uniq


def _folder_matches_process(folder_name: str, tokens: list[str]) -> bool:
    name = (folder_name or "").lower()
    if not name or not tokens:
        return False
    for t in tokens:
        if len(t) < 3:
            continue
        if t == name or name.startswith(t) or t in name or name in t:
            return True
    return False


class CacheSentry:
    """Generic cache scanner: any process → AppData/LocalAppData by name + Temp.

    Special-app path tables are optional hints only. New apps work without a
    dedicated code branch as long as they write under profile dirs or Temp.
    """

    def __init__(self, cfg: AppConfig | None = None, *, extra_roots: list[str] | None = None):
        self.cfg = cfg
        self.extra_roots = list(extra_roots or [])
        if cfg is not None:
            self.extra_roots.extend(cfg.get("capture", "cache_roots", default=[]) or [])

    def _min_bytes(self, override: int | None = None) -> int:
        if override is not None:
            return override
        if self.cfg is not None:
            return int(self.cfg.get("capture", "min_bytes", default=8192) or 8192)
        return 8192

    def _profile_bases(self) -> list[Path]:
        bases: list[Path] = []
        for raw in (
            r"%LOCALAPPDATA%",
            r"%APPDATA%",
            r"%LOCALAPPDATA%\Packages",  # UWP
        ):
            try:
                p = expand_env_path(raw)
            except Exception:
                continue
            if p.is_dir():
                bases.append(p)
        return bases

    def _discover_app_dirs(self, process_name: str) -> list[Path]:
        """Find profile directories that look like they belong to this process."""
        tokens = _process_tokens(process_name)
        if not tokens:
            return []
        found: list[Path] = []
        seen: set[str] = set()
        for base in self._profile_bases():
            try:
                children = list(base.iterdir())
            except OSError:
                continue
            for child in children:
                try:
                    if not child.is_dir():
                        continue
                except OSError:
                    continue
                if child.name.lower() in _SHARED_PROFILE_NAMES:
                    continue
                if not _folder_matches_process(child.name, tokens):
                    continue
                try:
                    key = str(child.resolve()).lower()
                except OSError:
                    key = str(child).lower()
                if key in seen:
                    continue
                seen.add(key)
                found.append(child)
                # Prefer common cache subfolders when present
                for sub in ("Cache", "Caches", "cache", "Cache_Data", "CachedData", "Code Cache"):
                    sp = child / sub
                    if sp.is_dir():
                        try:
                            sk = str(sp.resolve()).lower()
                        except OSError:
                            sk = str(sp).lower()
                        if sk not in seen:
                            seen.add(sk)
                            found.append(sp)
        return found

    def roots_for_process(self, process_name: str) -> list[Path]:
        """Universal roots for *any* process — no per-app branch required.

        1. Exact ``%LOCALAPPDATA%\\{App}`` / ``%APPDATA%\\{App}`` (+ Cache)
        2. Auto-discovered profile dirs whose name matches process tokens
        3. Shared Temp (always; foreign trees filtered at collect time)
        4. Optional non-obvious hints + config ``cache_roots``
        """
        app = _app_name(process_name)
        candidates: list[str] = []
        if app:
            candidates.extend(
                [
                    rf"%LOCALAPPDATA%\{app}\Cache",
                    rf"%APPDATA%\{app}\Cache",
                    rf"%LOCALAPPDATA%\{app}",
                    rf"%APPDATA%\{app}",
                ]
            )
        # Shared temp is optional (see collect_for_process include_temp).
        # Optional hints for odd layouts (never required for new apps)
        app_l = app.lower()
        for token, paths in _HINT_ROOTS.items():
            if token in app_l:
                candidates.extend(paths)
                break
        for r in self.extra_roots:
            candidates.append(str(r))

        out: list[Path] = []
        seen: set[str] = set()

        def _add(p: Path) -> None:
            try:
                if not p.exists() or not p.is_dir():
                    return
                key = str(p.resolve()).lower()
            except OSError:
                return
            if key in seen:
                return
            seen.add(key)
            out.append(p)

        for raw in candidates:
            try:
                _add(expand_env_path(raw))
            except Exception:
                continue
        for d in self._discover_app_dirs(process_name):
            _add(d)
        return out

    @staticmethod
    def _profile_owner_segment(path: Path) -> str | None:
        """Top-level profile folder under Local/Roaming AppData, if any."""
        s = str(path).replace("/", "\\")
        low = s.lower()
        for marker in ("\\appdata\\local\\", "\\appdata\\roaming\\"):
            i = low.find(marker)
            if i < 0:
                continue
            rest = s[i + len(marker) :]
            seg = rest.split("\\", 1)[0].strip()
            if not seg:
                return None
            if seg.lower() in _SHARED_PROFILE_NAMES:
                return None
            if seg.lower() == "packages":
                # UWP: next segment is package family
                parts = rest.split("\\")
                if len(parts) >= 2 and parts[1]:
                    return parts[1].lower()
                return None
            return seg.lower()
        return None

    @classmethod
    def _foreign_app_path(cls, path: Path, process_name: str) -> bool:
        """True if path lives under another app's profile tree."""
        tokens = _process_tokens(process_name)
        owner = cls._profile_owner_segment(path)
        if owner and tokens:
            if not _folder_matches_process(owner, tokens):
                # e.g. path under ...\Discord\... while process is steam
                return True
        return False

    def collect_for_process(
        self,
        process_name: str,
        pid: int | None,
        *,
        newer_than_sec: float = 600,
        limit: int = 40,
        min_bytes: int | None = None,
        max_depth: int = 4,
        include_temp: bool = False,
        max_files_visited: int = 800,
        check_integrity: bool = False,
    ) -> list[MediaCandidate]:
        """Scan app profile dirs (and optionally shared Temp) for recent media.

        By default skips shared Temp (cross-app noise + slow). Integrity/dims
        are deferred unless check_integrity=True (keep catch path light).
        """
        min_b = self._min_bytes(min_bytes)
        cutoff = time.time() - max(0.0, newer_than_sec)
        roots = self.roots_for_process(process_name)
        hits: list[tuple[float, Path, MediaType, str, int, bool]] = []

        temp_roots: set[str] = set()
        for raw in (r"%TEMP%", r"%LOCALAPPDATA%\Temp"):
            try:
                tr = expand_env_path(raw)
                if tr.is_dir():
                    temp_roots.add(str(tr.resolve()).lower())
            except Exception:
                pass

        if include_temp:
            for raw in (r"%TEMP%", r"%LOCALAPPDATA%\Temp"):
                try:
                    tr = expand_env_path(raw)
                    if tr.is_dir() and str(tr.resolve()).lower() not in {
                        str(r.resolve()).lower() for r in roots if r.exists()
                    }:
                        roots.append(tr)
                except Exception:
                    pass

        files_left = [max(50, int(max_files_visited))]

        for root in roots:
            if files_left[0] <= 0:
                break
            try:
                root_key = str(root.resolve()).lower()
            except OSError:
                root_key = str(root).lower()
            is_temp = root_key in temp_roots or root_key.endswith("\\temp")
            if is_temp and not include_temp:
                continue
            # Shared temp: shallower; foreign filter drops other apps
            depth = 2 if is_temp else max_depth
            for path, mtime, size, mtype, mime in self._scan_root(
                root,
                cutoff=cutoff,
                min_bytes=min_b,
                max_depth=depth,
                files_left=files_left,
            ):
                if self._foreign_app_path(path, process_name):
                    continue
                owned = not is_temp
                hits.append((mtime, path, mtype, mime, size, owned))

        # owned first, then newest
        hits.sort(key=lambda x: (0 if x[5] else 1, -x[0]))
        results: list[MediaCandidate] = []
        seen_paths: set[str] = set()
        for mtime, path, mtype, mime, size, owned in hits:
            key = str(path.resolve()).lower()
            if key in seen_paths:
                continue
            seen_paths.add(key)
            complete, creason = True, "ok"
            # Integrity is expensive; only when requested or small files
            if mtype == MediaType.VIDEO and (check_integrity or size <= 8 * 1024 * 1024):
                complete, creason = is_media_complete(path)
                if not complete:
                    continue
            w, h = (None, None)
            if check_integrity and mtype in (MediaType.IMAGE, MediaType.GIF):
                w, h = _try_image_size(path)
            results.append(
                MediaCandidate(
                    media_type=mtype,
                    source_kind=SourceKind.CACHE,
                    extension_id="builtin.cache",
                    process_name=process_name,
                    pid=pid,
                    title=path.name,
                    source_url=f"appcatch://cache/{path.name}",
                    local_path=str(path),
                    bytes_hint=size,
                    width=w,
                    height=h,
                    mime=mime,
                    score=(0.6 if owned else 0.45) if complete else 0.1,
                    meta={
                        "cache_root": str(path.parent),
                        "mtime": mtime,
                        "media_complete": complete if (mtype != MediaType.VIDEO or check_integrity or size <= 8 * 1024 * 1024) else None,
                        "incomplete_reason": "" if complete else creason,
                        "owned_profile": owned,
                    },
                )
            )
            if len(results) >= limit:
                break
        return results

    def _scan_root(
        self,
        root: Path,
        *,
        cutoff: float,
        min_bytes: int,
        max_depth: int,
        files_left: list[int] | None = None,
    ) -> Iterable[tuple[Path, float, int, MediaType, str]]:
        root_depth = len(root.parts)
        try:
            for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
                if files_left is not None and files_left[0] <= 0:
                    dirnames.clear()
                    return
                pdir = Path(dirpath)
                depth = len(pdir.parts) - root_depth
                if depth > max_depth:
                    dirnames.clear()
                    continue
                # prune skipped dirs
                kept = []
                for d in dirnames:
                    if _path_skipped(pdir / d):
                        continue
                    kept.append(d)
                dirnames[:] = kept
                if _path_skipped(pdir):
                    dirnames.clear()
                    continue
                for name in filenames:
                    if files_left is not None and files_left[0] <= 0:
                        return
                    fp = pdir / name
                    if _path_skipped(fp):
                        continue
                    try:
                        st = fp.stat()
                    except OSError:
                        continue
                    if files_left is not None:
                        files_left[0] -= 1
                    if st.st_size < min_bytes:
                        continue
                    if st.st_mtime < cutoff:
                        continue
                    sniffed = sniff_media(fp)
                    if not sniffed:
                        continue
                    mtype, mime = sniffed
                    yield fp, st.st_mtime, st.st_size, mtype, mime
        except OSError:
            return
