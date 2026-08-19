from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from app.core.config import AppConfig, ROOT
from app.core.dedupe import dedupe_candidates
from app.core.filters import apply_filters, is_quality
from app.core.grade import apply_grades, session_summary
from app.core.models import (
    CaptureSession,
    MediaCandidate,
    MediaType,
    RecentItem,
    SourceKind,
    WindowInfo,
    utcnow,
)
from app.core.scoring import sort_candidates
from app.lmw.client import LmwClient
from app.sources.cache_sentry import CacheSentry
from app.sources.folder_watch import FolderWatch
from app.sources.screenshot import capture_window
from app.sources.url_download import materialize_candidate

if TYPE_CHECKING:
    from app.extensions.loader import ExtensionRegistry
    from app.sources.network_sentry import NetworkSentry
    from app.state.recent_store import RecentStore


class CapturePipeline:
    def __init__(
        self,
        cfg: AppConfig,
        lmw: LmwClient,
        registry: ExtensionRegistry,
        recent: RecentStore,
        network_sentry: NetworkSentry | None = None,
    ):
        self.cfg = cfg
        self.lmw = lmw
        self.registry = registry
        self.recent = recent
        # optional NetworkSentry for PID/process network observations
        self.network_sentry = network_sentry
        # session demos / legacy network buffer: pid -> candidates
        self._network_buffer: dict[int, list[MediaCandidate]] = {}
        self._cache_sentry = CacheSentry(cfg)
        self._folder_watch = FolderWatch(cfg=cfg, include_downloads=True)
        # temporary widen from UI "boost 30s" — scoped to one process, time-limited
        self._cache_boost_sec: float = 0.0
        self._cache_boost_process: str = ""
        self._cache_boost_until: float = 0.0

    def set_cache_boost(
        self,
        process_name: str,
        *,
        newer_than_sec: float = 3600.0,
        duration_sec: float = 30.0,
    ) -> None:
        """Widen cache/folder scan only for this process, until duration expires."""
        import time as _time

        self._cache_boost_process = (process_name or "").lower().removesuffix(".exe")
        self._cache_boost_sec = float(newer_than_sec)
        self._cache_boost_until = _time.time() + max(1.0, float(duration_sec))

    def clear_cache_boost(self) -> None:
        self._cache_boost_sec = 0.0
        self._cache_boost_process = ""
        self._cache_boost_until = 0.0

    def _active_cache_boost(self, process_name: str) -> float:
        """Return boost newer_than_sec if still valid for this process, else 0."""
        import time as _time

        if not self._cache_boost_sec or not self._cache_boost_process:
            return 0.0
        if _time.time() > float(self._cache_boost_until or 0):
            self.clear_cache_boost()
            return 0.0
        cur = (process_name or "").lower().removesuffix(".exe")
        if cur != self._cache_boost_process:
            return 0.0
        return float(self._cache_boost_sec)

    def push_network_candidate(self, pid: int, cand: MediaCandidate) -> None:
        """Buffer a network candidate by PID; also mirrors into NetworkSentry when set."""
        if cand.pid is None:
            cand.pid = pid
        self._network_buffer.setdefault(pid, []).append(cand)
        sentry = self.network_sentry
        if sentry is not None and cand.source_url:
            sentry.observe(
                cand.source_url,
                pid=pid,
                process_name=cand.process_name or "",
                mime=cand.mime or "",
                content_length=cand.bytes_hint,
                headers=dict(cand.headers or {}),
            )

    def build_session(
        self,
        info: WindowInfo,
        *,
        extra: list[MediaCandidate] | None = None,
    ) -> CaptureSession:
        session = CaptureSession(
            hwnd=info.hwnd,
            pid=info.pid,
            process_name=info.process_name,
            window_title=info.title,
        )
        cands: list[MediaCandidate] = []

        # NetworkSentry: by pid and process name
        sentry = self.network_sentry
        if sentry is not None:
            seen_ids: set[str] = set()
            for c in sentry.candidates_for_pid(info.pid):
                if c.id not in seen_ids:
                    seen_ids.add(c.id)
                    cands.append(c)
            if info.process_name:
                for c in sentry.candidates_for_process(info.process_name):
                    if c.id not in seen_ids:
                        seen_ids.add(c.id)
                        cands.append(c)

        # legacy in-memory buffer (demo / direct push / clipboard files)
        if info.pid and info.pid in self._network_buffer:
            cands.extend(list(self._network_buffer.get(info.pid, [])))

        # force-read clipboard / caller extras (P0)
        if extra:
            for c in extra:
                if c.process_name in ("", "clipboard") and info.process_name:
                    c.process_name = info.process_name
                if c.pid is None and info.pid is not None:
                    c.pid = info.pid
                cands.append(c)

        # extensions L-B
        cands.extend(self.registry.collect_for_session(session))

        # L-A: extensions that only have URL rules don't produce without network;
        # still record matching extension ids for UI
        for ext in self.registry.enabled_for_process(info.process_name):
            if ext.id not in session.extension_ids:
                session.extension_ids.append(ext.id)

        # cache scan — generic for any process (profile dirs by name + Temp)
        if bool(self.cfg.get("capture", "cache_enabled", default=True)):
            try:
                newer = float(self.cfg.get("capture", "cache_newer_than_sec", default=600) or 600)
                boost = self._active_cache_boost(info.process_name or "")
                if boost and boost > newer:
                    newer = boost
                limit = int(self.cfg.get("capture", "cache_limit", default=40) or 40)
                if boost:
                    limit = max(limit, 80)
                cands.extend(
                    self._cache_sentry.collect_for_process(
                        info.process_name,
                        info.pid,
                        newer_than_sec=newer,
                        limit=limit,
                        # Shared Temp only when process boost is active (fast default path)
                        include_temp=bool(boost),
                        max_files_visited=1200 if boost else 600,
                        check_integrity=False,
                    )
                )
            except Exception as e:
                session.errors.append(f"cache: {e}")

        # folder watch (config watch_dirs + Downloads) — process-scoped boost only
        watch_dirs = self.cfg.get("watch_dirs", default=[]) or []
        if watch_dirs or self._folder_watch.dirs:
            try:
                newer = float(self.cfg.get("capture", "cache_newer_than_sec", default=600) or 600)
                boost = self._active_cache_boost(info.process_name or "")
                if boost and boost > newer:
                    newer = boost
                cands.extend(
                    self._folder_watch.drain_new(
                        process_name=info.process_name,
                        pid=info.pid,
                        newer_than_sec=newer,
                    )
                )
            except Exception as e:
                session.errors.append(f"watch: {e}")

        cands = dedupe_candidates(cands)
        cands = apply_filters(cands, self.cfg)
        cands = sort_candidates(cands, "recommend")
        apply_grades(cands)
        session.candidates = cands
        return session

    def ensure_screenshot(self, info: WindowInfo, session: CaptureSession) -> MediaCandidate:
        shot = capture_window(info)
        session.candidates.append(shot)
        session.candidates = sort_candidates(
            apply_filters(dedupe_candidates(session.candidates), self.cfg)
        )
        apply_grades(session.candidates)
        return shot

    def download_dir(self) -> Path:
        d = ROOT / "data" / "tmp" / "downloads"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def materialize(
        self,
        cand: MediaCandidate,
        *,
        progress_cb=None,
    ) -> tuple[bool, str]:
        """Ensure local file for ingest/preview. Returns (ok, message).

        progress_cb may be:
          - (downloaded: int, total: int|None, phase: str) -> None
          - or legacy (msg: str) -> None
        """
        if not bool(self.cfg.get("download", "enabled", default=True)):
            if cand.local_path and Path(cand.local_path).is_file():
                return True, "local"
            if (cand.source_url or "").startswith("http"):
                return True, "url-only"  # LMW ingest by URL
            return False, "no file or url"
        if cand.local_path and Path(cand.local_path).is_file():
            return True, "local"
        if not (cand.source_url or "").startswith("http"):
            return False, "无本地文件且无链接"

        def _cb(done: int, total: int | None, phase: str) -> None:
            if not progress_cb:
                return
            try:
                progress_cb(done, total, phase)
            except TypeError:
                # legacy string callback
                try:
                    pct = int(100 * done / total) if total else 0
                    progress_cb(f"{phase} {pct}% {done}")
                except Exception:
                    pass

        prefer = bool(self.cfg.get("download", "prefer_ytdlp", default=True))
        timeout = float(self.cfg.get("download", "timeout_sec", default=180) or 180)
        max_bytes = int(self.cfg.get("download", "max_bytes", default=524288000) or 524288000)
        r = materialize_candidate(
            cand,
            self.download_dir(),
            prefer_ytdlp=prefer,
            timeout=timeout,
            max_bytes=max_bytes,
            progress_cb=_cb,
        )
        if r.ok:
            cand.meta["media_complete"] = True
            if r.path:
                cand.local_path = cand.local_path or r.path
            apply_grades([cand])
            return True, r.method or "ok"
        return False, r.error or "下载失败"

    def session_headline(self, session: CaptureSession) -> str:
        return str(session_summary(session.candidates).get("headline") or "")

    def decide_ui(self, session: CaptureSession) -> str:
        """
        Returns: 'ingest_single' | 'grid' | 'screenshot_fallback' | 'empty'

        Smart catch always prefers grid so the user confirms before ingest.
        one_click_when_single is legacy and only applies when explicitly True.
        """
        visible = [c for c in session.candidates if not c.filtered_out]
        one_click = bool(self.cfg.get("ui", "one_click_when_single", default=False))
        allow_shot = bool(self.cfg.get("ui", "allow_screenshot_fallback", default=True))

        if len(visible) >= 1:
            # Default: always grid (user confirms). Optional one-click only if enabled.
            if len(visible) == 1 and one_click:
                return "ingest_single"
            return "grid"
        # zero visible
        if allow_shot:
            return "screenshot_fallback"
        return "empty"

    def auto_select_quality(self, session: CaptureSession) -> None:
        for c in session.candidates:
            c.selected = is_quality(c) and not c.filtered_out

    def build_tags(self, cand: MediaCandidate, extra: list[str] | None = None) -> list[str]:
        tags = list(self.cfg.get("ingest", "default_tags", default=[]) or [])
        if self.cfg.get("ingest", "auto_tag_app", default=True) and cand.process_name:
            proc = cand.process_name.replace(".exe", "")
            tags.append(f"app:{proc}")
        if cand.extension_id and cand.meta.get("suggested_tags"):
            tags.extend(cand.meta["suggested_tags"])
        # extension suggested from registry
        for ext in self.registry.extensions:
            if ext.id == cand.extension_id and ext.suggested_tags:
                tags.extend(ext.suggested_tags)
        if extra:
            tags.extend(extra)
        # normalize
        seen = set()
        out = []
        for t in tags:
            t = str(t).strip()
            if t and t not in seen:
                seen.add(t)
                out.append(t)
        return out

    def ingest_candidate(
        self,
        cand: MediaCandidate,
        *,
        restricted: bool | None = None,
        use_jasna: bool | None = None,
        extra_tags: list[str] | None = None,
        materialize_first: bool = True,
    ) -> RecentItem:
        # L-B before_ingest hook
        try:
            cand = self.registry.apply_before_ingest(cand)
        except Exception:
            pass
        if restricted is None:
            restricted = bool(self.cfg.get("ingest", "restricted", default=False))
        if use_jasna is None:
            use_jasna = bool(self.cfg.get("ingest", "use_jasna", default=False))
        tags = self.build_tags(cand, extra_tags)
        rid = uuid4().hex[:10]
        try:
            # Refuse truncated cache videos (play ~1s then black)
            if cand.local_path and Path(cand.local_path).is_file():
                mt = cand.media_type.value if isinstance(cand.media_type, MediaType) else str(cand.media_type)
                if mt == "video":
                    from app.sources.media_integrity import is_media_complete

                    ok_m, reason = is_media_complete(cand.local_path)
                    if not ok_m:
                        raise RuntimeError(
                            "这是不完整的缓存分片，不能入库为完整视频。"
                            f"（{reason}）请在 Discord 右键视频→复制链接后抓取，或另存到「下载」文件夹。"
                        )

            # P1: prefer local file via direct/yt-dlp when only URL present
            if materialize_first and not (
                cand.local_path and Path(cand.local_path).is_file()
            ):
                if (cand.source_url or "").startswith("http"):
                    ok, msg = self.materialize(cand)
                    if not ok and not (cand.source_url or "").startswith("http"):
                        raise RuntimeError(msg)

            if cand.local_path and Path(cand.local_path).is_file():
                mt = cand.media_type.value if isinstance(cand.media_type, MediaType) else str(cand.media_type)
                res = self.lmw.upload(
                    cand.local_path,
                    title=cand.title or cand.display_name(),
                    source_url=cand.source_url,
                    media_type=mt,
                    tags=tags,
                    restricted=restricted,
                    use_jasna=use_jasna and mt == "video",
                )
            elif cand.source_url.startswith("http"):
                mt = cand.media_type.value if isinstance(cand.media_type, MediaType) else str(cand.media_type)
                res = self.lmw.ingest(
                    [
                        {
                            "url": cand.source_url,
                            "media_type": mt,
                            "title": cand.title or cand.display_name(),
                            "headers": cand.headers or {},
                            "tags": tags,
                            "restricted": restricted,
                            "use_jasna": use_jasna and mt == "video",
                        }
                    ],
                    tags=tags,
                    restricted=restricted,
                    use_jasna=use_jasna,
                )
                # ingest returns jobs; treat as success queued
                item = RecentItem(
                    id=rid,
                    title=cand.title or cand.display_name(),
                    process_name=cand.process_name,
                    media_type=mt,
                    status="success",
                    media_id=None,
                    source_url=cand.source_url,
                    local_path=cand.local_path,
                    thumb_path=cand.thumb_path,
                )
                self.recent.add(item)
                return item
            else:
                raise RuntimeError("候选没有可上传的文件或 URL")

            dup = bool(res.get("duplicate"))
            mid = res.get("media_id")
            item = RecentItem(
                id=rid,
                title=cand.title or cand.display_name(),
                process_name=cand.process_name,
                media_type=str(cand.media_type.value if isinstance(cand.media_type, MediaType) else cand.media_type),
                status="duplicate" if dup else "success",
                media_id=mid,
                source_url=cand.source_url,
                local_path=cand.local_path,
                thumb_path=cand.thumb_path,
            )
            self.recent.add(item)
            return item
        except Exception as e:
            item = RecentItem(
                id=rid,
                title=cand.title or cand.display_name(),
                process_name=cand.process_name,
                media_type=str(cand.media_type.value if isinstance(cand.media_type, MediaType) else cand.media_type),
                status="fail",
                error=str(e),
                source_url=cand.source_url,
                local_path=cand.local_path,
                thumb_path=cand.thumb_path,
            )
            self.recent.add(item)
            return item

    def inject_demo_candidates(self, info: WindowInfo, n: int = 3) -> list[MediaCandidate]:
        """Dev helper: create placeholder candidates from repeated screenshots cropped — uses real shots."""
        # For multi-grid testing without network: capture once and clone meta with different ids
        base = capture_window(info)
        out = [base]
        for i in range(1, n):
            c = MediaCandidate(
                media_type=MediaType.IMAGE,
                source_kind=SourceKind.DEMO,
                extension_id="demo",
                process_name=info.process_name,
                pid=info.pid,
                title=f"{base.title} #{i+1}",
                source_url=f"{base.source_url}#{i}",
                local_path=base.local_path,
                bytes_hint=base.bytes_hint,
                width=base.width,
                height=base.height,
                mime=base.mime,
                thumb_path=base.thumb_path,
                score=0.4 - i * 0.05,
            )
            out.append(c)
        return out
