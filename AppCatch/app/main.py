from __future__ import annotations

import sys
import time
import traceback
import webbrowser
from pathlib import Path

import threading

from PySide6.QtCore import QTimer, QObject, Qt, Signal
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import QApplication, QMessageBox

from app.core.config import AppConfig
from app.core.grade import session_summary, CandidateGrade, grade_candidate
from app.core.pipeline import CapturePipeline
from app.core.window_tracker import HoverTracker
from app.core.models import WindowInfo, SourceKind
from app.extensions.loader import ExtensionRegistry
from app.lmw.client import LmwClient
from app.state.recent_store import RecentStore
from app.sources.clipboard_sentry import ClipboardSentry
from app.sources.network_inbox import NetworkInboxWatcher
from app.sources.network_sentry import NetworkSentry
from app.ui.download_job import DownloadJob
from app.ui.hover_button import HoverCatchButton
from app.ui.main_panel import MainPanel
from app.ui.media_grid_panel import MediaGridPanel
from app.ui.toasts import ToastHost
from app.ui.tray import TrayController


class AppController(QObject):
    # Background catch finished: (token, mode, info, session|None, error|None)
    catch_finished = Signal(int, str, object, object, object)

    def __init__(self, app: QApplication):
        super().__init__()
        self.app = app
        self.cfg = AppConfig.load()
        self.lmw = LmwClient(self.cfg)
        self.recent = RecentStore()
        self.registry = ExtensionRegistry(self.cfg)
        self.registry.reload()

        self.network_sentry = NetworkSentry()
        self.network_sentry.set_claim_hook(
            lambda url, **kw: self.registry.claim_network_url(url, **kw)
        )
        self.pipeline = CapturePipeline(
            self.cfg, self.lmw, self.registry, self.recent, network_sentry=self.network_sentry
        )
        # Bootstrap folder watch off the critical catch path (first catch must not walk Downloads)
        try:
            self.pipeline._folder_watch.bootstrap()
        except Exception:
            traceback.print_exc()
        self.clipboard = ClipboardSentry()
        self._inbox_watcher: NetworkInboxWatcher | None = None
        if bool(self.cfg.get("capture", "network_enabled", default=True)):
            try:
                self._inbox_watcher = NetworkInboxWatcher(self.network_sentry)
                self._inbox_watcher.start()
            except Exception:
                traceback.print_exc()

        self.tray = TrayController()
        self.panel = MainPanel(self.cfg, self.lmw, self.recent, self.registry)
        self.hover = HoverCatchButton()
        self.grid = MediaGridPanel()
        self.toast = ToastHost()

        self._target: WindowInfo | None = None
        self._paused = False
        self._busy = False
        self._catch_token = 0
        self._boost_until: float = 0.0
        self._boost_pid: int | None = None
        self._boost_process: str = ""
        self.catch_finished.connect(self._on_catch_finished)

        ignore = list(self.cfg.get("capture", "ignore_processes", default=[]) or [])
        # Only ignore our own host process names when they are EXACT (see is_ignored).
        # Do not use broad prefixes.
        for extra in ("python", "pythonw", "appcatch"):
            if extra not in ignore:
                ignore.append(extra)
        self.tracker = HoverTracker(
            dwell_ms=int(self.cfg.get("ui", "hover_dwell_ms", default=200)),
            ignore_names=ignore,
            on_target=self._on_hover_target,
        )

        self._wire()
        # Create native hwnd early and register so button doesn't self-dismiss
        self.hover.set_target(
            WindowInfo(hwnd=0, pid=None, process_name="init", title="", rect=(0, 0, 100, 100)),
            0,
            "就绪",
        )
        QTimer.singleShot(50, self._register_overlay)
        QTimer.singleShot(400, lambda: self.hover.set_target(None))

        self._poll = QTimer()
        self._poll.setInterval(50)
        self._poll.timeout.connect(self._tick)
        self._poll.start()

        self._debug_timer = QTimer()
        self._debug_timer.setInterval(300)
        self._debug_timer.timeout.connect(self._refresh_hover_debug)
        self._debug_timer.start()

        self._clip_timer = QTimer()
        self._clip_timer.setInterval(1200)
        self._clip_timer.timeout.connect(self._poll_clipboard)
        self._clip_timer.start()

        self._health_timer = QTimer()
        self._health_timer.setInterval(8000)
        self._health_timer.timeout.connect(self.check_health)
        self._health_timer.start()
        self.check_health()

        # Global-ish shortcuts while app runs (active when any window focused; tray-only limited)
        self._sc_catch = QShortcut(QKeySequence("Ctrl+Shift+G"), self.panel)
        self._sc_catch.setContext(Qt.ShortcutContext.ApplicationShortcut)
        self._sc_catch.activated.connect(lambda: self.run_catch(mode="smart"))
        self._sc_shot = QShortcut(QKeySequence("Ctrl+Shift+S"), self.panel)
        self._sc_shot.setContext(Qt.ShortcutContext.ApplicationShortcut)
        self._sc_shot.activated.connect(lambda: self.run_catch(mode="screenshot"))
        self._sc_grid = QShortcut(QKeySequence("Ctrl+Shift+E"), self.panel)
        self._sc_grid.setContext(Qt.ShortcutContext.ApplicationShortcut)
        self._sc_grid.activated.connect(lambda: self.run_catch(mode="grid"))

        self.panel.show()

    def _wire(self) -> None:
        self.tray.act_panel.triggered.connect(self.panel.show)
        self.tray.act_panel.triggered.connect(self.panel.raise_)
        self.tray.act_lib.triggered.connect(self.open_library)
        self.tray.act_quit.triggered.connect(self.app.quit)
        self.tray.act_pause.toggled.connect(self._set_paused)
        self.tray.act_ext.triggered.connect(self.panel.focus_extensions)
        self.tray.tray.activated.connect(self._tray_activated)

        self.panel.open_library.connect(self.open_library)
        self.panel.test_connection.connect(self.check_health)
        self.panel.pause_changed.connect(self._set_paused)
        self.panel.config_changed.connect(self._reload_cfg)
        self.panel.reload_extensions.connect(self._reload_ext)

        self.hover.clicked_catch.connect(lambda: self.run_catch(mode="smart"))
        self.hover.clicked_screenshot.connect(lambda: self.run_catch(mode="screenshot"))
        self.hover.clicked_grid.connect(lambda: self.run_catch(mode="grid"))
        self.hover.clicked_boost.connect(self._boost)
        self.hover.clicked_clipboard.connect(self._catch_clipboard)

        self.grid.ingest_requested.connect(self._ingest_list)
        self.grid.refresh_requested.connect(lambda: self.run_catch(mode="grid"))
        self.grid.screenshot_requested.connect(self._grid_add_shot)
        self.grid.download_requested.connect(self._download_list)
        self.grid.status_message.connect(self.toast.show_message)
        self._dl_job: DownloadJob | None = None
        self._dl_poll = QTimer(self)
        self._dl_poll.setInterval(100)  # 10 Hz UI refresh of progress
        self._dl_poll.timeout.connect(self._poll_download_progress)

    def _tray_activated(self, reason) -> None:
        from PySide6.QtWidgets import QSystemTrayIcon

        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.panel.show()
            self.panel.raise_()

    def _register_overlay(self) -> None:
        hwnd = self.hover.native_hwnd()
        self.tracker.register_overlay_hwnd(hwnd)

    def _refresh_hover_debug(self) -> None:
        text = self.tracker.debug_last or "…"
        if self._target:
            text = f"目标 {self._target.process_name} | {text}"
        elif self._paused:
            text = "已暂停"
        self.panel.set_hover_debug(text)

    def _set_paused(self, paused: bool) -> None:
        self._paused = paused
        self.tracker.set_enabled(
            (not paused) and bool(self.cfg.get("ui", "show_hover_button", default=True))
        )
        self.tray.act_pause.setChecked(paused)
        self.panel.b_pause.setChecked(paused)
        if paused:
            self.hover.set_target(None)

    def _reload_cfg(self) -> None:
        self.cfg = AppConfig.load()
        self.lmw = LmwClient(self.cfg)
        self.pipeline.cfg = self.cfg
        self.pipeline.lmw = self.lmw
        self.tracker.dwell_ms = int(self.cfg.get("ui", "hover_dwell_ms", default=200))
        ignore = list(self.cfg.get("capture", "ignore_processes", default=[]) or [])
        for extra in ("python", "pythonw", "appcatch"):
            if extra not in ignore:
                ignore.append(extra)
        self.tracker.ignore_names = ignore
        self.tracker.set_enabled(
            (not self._paused) and bool(self.cfg.get("ui", "show_hover_button", default=True))
        )
        self.check_health()

    def _reload_ext(self) -> None:
        self.registry.reload()
        self.panel.refresh_extensions()
        self.toast.show_message("扩展已重新加载")

    def _tick(self) -> None:
        if self._busy:
            return
        self.tracker.tick(time.time() * 1000)

    def _poll_clipboard(self) -> None:
        if self._paused or self._busy:
            return
        try:
            new_items = self.clipboard.poll()
        except Exception:
            return
        for c in new_items:
            # attach to last target process if any
            if self._target:
                c.process_name = c.process_name or self._target.process_name
                c.pid = c.pid or self._target.pid
            if c.source_url and c.source_url.startswith("http"):
                self.network_sentry.observe(
                    c.source_url,
                    pid=c.pid,
                    process_name=c.process_name or "",
                    mime=c.mime or "",
                    content_length=c.bytes_hint,
                )
            elif c.local_path and c.pid:
                self.pipeline.push_network_candidate(c.pid, c)
            elif c.local_path:
                # keep as process-less recent via zero pid buffer skip — store on sentry-like list
                if self._target and self._target.pid:
                    self.pipeline.push_network_candidate(self._target.pid, c)

    def _candidate_count(self, info: WindowInfo) -> int:
        n = 0
        seen: set[str] = set()
        for c in self.network_sentry.candidates_for_pid(info.pid):
            if c.id not in seen:
                seen.add(c.id)
                n += 1
        if info.process_name:
            for c in self.network_sentry.candidates_for_process(info.process_name):
                if c.id not in seen:
                    seen.add(c.id)
                    n += 1
        if info.pid and info.pid in self.pipeline._network_buffer:
            n += len(self.pipeline._network_buffer[info.pid])
        return n

    def _on_hover_target(self, info: WindowInfo | None) -> None:
        prev = self._target
        self._target = info
        # When user switches to a different process: drop boost, invalidate in-flight
        # catch, and hide previous grid so sessions never cross-contaminate.
        if info is not None and prev is not None:
            a = (prev.process_name or "").lower().removesuffix(".exe")
            b = (info.process_name or "").lower().removesuffix(".exe")
            if a and b and a != b:
                try:
                    self.pipeline.clear_cache_boost()
                except Exception:
                    pass
                self._boost_until = 0.0
                self._boost_pid = None
                self._boost_process = ""
                self._catch_token += 1  # invalidate in-flight worker for old app
                try:
                    self.grid.clear_session()
                except Exception:
                    pass
                try:
                    # Drop legacy network buffer for other pids (keep only new pid)
                    if info.pid is not None and hasattr(self.pipeline, "_network_buffer"):
                        buf = self.pipeline._network_buffer
                        for k in list(buf.keys()):
                            if k != info.pid:
                                buf.pop(k, None)
                except Exception:
                    pass
        if info is None or self._paused:
            self.hover.set_target(None)
            return
        if not self.cfg.get("ui", "show_hover_button", default=True):
            self.hover.set_target(None)
            return
        # Skip zero hwnd init / invalid
        if not info.hwnd:
            return
        count = self._candidate_count(info)
        level = "截取"
        if count > 0:
            level = "抓取"
        else:
            for e in self.registry.enabled_for_process(info.process_name):
                if e.match_processes and not e.is_builtin:
                    level = "抓取"
                    break
        if self._boost_active(info):
            level = "抓取"
        # Reposition when hwnd/process changes so button follows the new app
        force = bool(
            prev is None
            or prev.hwnd != info.hwnd
            or (prev.process_name or "").lower() != (info.process_name or "").lower()
        )
        self.hover.set_target(info, count=count, level=level, force_reposition=force)
        self._register_overlay()

    def _boost_active(self, info: WindowInfo | None = None) -> bool:
        if time.time() > self._boost_until:
            return False
        if info is None:
            return True
        if self._boost_pid and info.pid == self._boost_pid:
            return True
        if self._boost_process and info.process_name:
            a = self._boost_process.lower().removesuffix(".exe")
            b = info.process_name.lower().removesuffix(".exe")
            return a == b
        return False

    @staticmethod
    def _looks_like_other_app_media(cand, process_name: str) -> bool:
        """True if candidate is tagged/URL-owned by a different product than the target.

        Generic rule: host/token map + path profile owner vs process tokens.
        Not a whitelist of supported apps — only a cross-contamination filter.
        """
        from app.sources.cache_sentry import CacheSentry, _process_tokens, _folder_matches_process

        proc = (process_name or "").lower().removesuffix(".exe")
        tokens = _process_tokens(process_name)
        url = (getattr(cand, "source_url", None) or "").lower()
        path = (getattr(cand, "local_path", None) or "")
        pn = (getattr(cand, "process_name", None) or "").lower().removesuffix(".exe")

        # Host substring → owning token (must match target process tokens)
        host_owners: list[tuple[str, str]] = [
            ("cdn.discordapp.com", "discord"),
            ("media.discordapp.net", "discord"),
            ("discord.com/attachments", "discord"),
            ("discordapp.com", "discord"),
            ("steamstatic.com", "steam"),
            ("steamcontent.com", "steam"),
            ("steampowered.com", "steam"),
            ("music.126.net", "cloudmusic"),
            ("netease.com", "cloud"),
        ]
        for host, owner in host_owners:
            if host in url and owner not in proc and not any(owner in t for t in tokens):
                return True

        # Candidate already labeled with another process name
        if pn and tokens and pn not in ("clipboard",) and not _folder_matches_process(pn, tokens):
            # e.g. cand.process_name=Discord.exe while hovering Steam
            if pn != proc:
                return True

        # Local path under another app's AppData tree
        if path:
            try:
                from pathlib import Path as _P

                if CacheSentry._foreign_app_path(_P(path), process_name):
                    return True
            except Exception:
                pass
        return False

    def check_health(self) -> None:
        try:
            h = self.lmw.health()
            ok = bool(h.get("ok", True) or h)
            self.panel.set_lmw_ok(True)
            self.tray.set_status("green" if not self._paused else "gray")
        except Exception as e:
            self.panel.set_lmw_ok(False, str(e))
            self.tray.set_status("red")

    def open_library(self) -> None:
        webbrowser.open(self.lmw.open_library_url())

    def _snapshot_clipboard(self, info: WindowInfo | None = None) -> list:
        """Force-read clipboard media (no hash skip) for smart catch."""
        from app.sources.clipboard_sentry import snapshot_clipboard_media

        try:
            items = snapshot_clipboard_media(
                process_name=(info.process_name if info else None) or "clipboard",
                pid=info.pid if info else None,
                remember=False,
                sentry=self.clipboard,
            )
        except Exception:
            items = []
        for c in items:
            if info:
                c.process_name = info.process_name or c.process_name
                c.pid = info.pid if info.pid is not None else c.pid
            if c.source_url and c.source_url.startswith("http"):
                try:
                    self.network_sentry.observe(
                        c.source_url,
                        pid=c.pid,
                        process_name=c.process_name or "",
                        mime=c.mime or "",
                        content_length=c.bytes_hint,
                    )
                except Exception:
                    pass
            elif c.local_path and info and info.pid:
                self.pipeline.push_network_candidate(info.pid, c)
        return items

    def _merge_clipboard_into_sentry(self, info: WindowInfo | None = None) -> int:
        """Pull clipboard media into network buffer; return new count."""
        return len(self._snapshot_clipboard(info))

    def _catch_clipboard(self) -> None:
        """Right-click: grab clipboard media/links (Discord video link workflow)."""
        info = self._target
        extra = self._snapshot_clipboard(info)
        if info is None:
            self.toast.show_message(
                f"已读取剪贴板 {len(extra)} 项。请悬停目标窗口再点抓取。"
            )
            return
        session = self.pipeline.build_session(info, extra=extra)
        from app.core.models import SourceKind
        from app.core.grade import session_summary

        usable = [
            c
            for c in session.candidates
            if not c.filtered_out
            and (
                c.source_kind
                in (SourceKind.NETWORK, SourceKind.FILE, SourceKind.CACHE, SourceKind.EXTENSION)
                or (c.source_url or "").startswith("http")
                or (c.local_path and Path(c.local_path).is_file() if c.local_path else False)
            )
            and c.source_kind != SourceKind.SCREENSHOT
        ]
        # include pure clipboard extras even if filtered weirdly
        if not usable and extra:
            usable = [c for c in extra if not c.filtered_out]
        if not usable:
            self.toast.show_message(
                "剪贴板没有可用媒体链接。\n"
                "Discord：右键视频 → 复制链接 → 再点抓取（智能抓取会自动读剪贴板）"
            )
            return
        summary = session_summary(usable)
        if len(usable) == 1:
            item = self.pipeline.ingest_candidate(usable[0])
            self._report_item(item)
            self.panel.refresh_recent()
            return
        self.pipeline.auto_select_quality(session)
        for c in session.candidates:
            if c.id in {u.id for u in usable}:
                c.selected = not c.filtered_out
        self.grid.open_session(
            session,
            restricted=bool(self.cfg.get("ingest", "restricted")),
            use_jasna=bool(self.cfg.get("ingest", "use_jasna")),
        )
        self.toast.show_message(f"剪贴板相关 {summary.get('headline', len(usable))}，请勾选入库")

    def _boost(self) -> None:
        info = self._target
        if info is None:
            try:
                import win32gui
                from app.core.window_tracker import window_from_point

                x, y = win32gui.GetCursorPos()
                info = window_from_point(x, y)
            except Exception:
                info = None
        self._boost_until = time.time() + 30.0
        self._boost_pid = info.pid if info else None
        self._boost_process = (info.process_name if info else "") or ""
        # widen cache window during boost — only for this process, 30s
        try:
            self.pipeline.set_cache_boost(
                self._boost_process,
                newer_than_sec=3600.0,
                duration_sec=30.0,
            )
        except Exception:
            pass
        name = self._boost_process or "当前窗口"
        self.toast.show_message(f"已加强 {name} 30 秒：放宽缓存扫描 + 优先抓取")

    def run_catch(self, mode: str = "smart") -> None:
        info = self._target
        if info is None:
            # try current cursor window
            from app.core.window_tracker import window_from_point
            import win32gui

            try:
                x, y = win32gui.GetCursorPos()
                info = window_from_point(x, y)
            except Exception:
                info = None
        if info is None:
            self.toast.show_message("没有目标窗口")
            return
        if self._busy:
            self.toast.show_message("正在抓取中…")
            return
        self._busy = True
        self.tray.set_status("orange")
        proc_short = (info.process_name or "?").replace(".exe", "")
        self.toast.show_message(f"正在抓取 {proc_short}…")

        # Clipboard must stay on UI thread (Qt clipboard).
        try:
            raw_extra = self._snapshot_clipboard(info)
            if self._boost_active(info) or mode == "clipboard":
                extra = raw_extra
            else:
                extra = [
                    c
                    for c in raw_extra
                    if not self._looks_like_other_app_media(c, info.process_name or "")
                ]
        except Exception:
            traceback.print_exc()
            extra = []

        if self._boost_active(info):
            try:
                self.pipeline.set_cache_boost(
                    info.process_name or "",
                    newer_than_sec=3600.0,
                    duration_sec=30.0,
                )
            except Exception:
                pass

        self._catch_token += 1
        token = self._catch_token
        # Snapshot window info for worker (immutable fields)
        info_snap = WindowInfo(
            hwnd=info.hwnd,
            pid=info.pid,
            process_name=info.process_name,
            title=info.title,
            rect=info.rect,
        )
        demo_multi = bool(getattr(self.panel, "demo_multi", False))

        def _worker() -> None:
            err: Exception | None = None
            session = None
            try:
                session = self.pipeline.build_session(info_snap, extra=list(extra))
                if demo_multi and mode in ("smart", "grid"):
                    demos = self.pipeline.inject_demo_candidates(info_snap, 3)
                    session.candidates = demos
                    from app.core.filters import apply_filters
                    from app.core.scoring import sort_candidates
                    from app.core.dedupe import dedupe_candidates
                    from app.core.grade import apply_grades

                    session.candidates = sort_candidates(
                        apply_filters(dedupe_candidates(session.candidates), self.cfg)
                    )
                    apply_grades(session.candidates)
                    self.pipeline.auto_select_quality(session)
            except Exception as e:
                err = e
                traceback.print_exc()
            self.catch_finished.emit(token, mode, info_snap, session, err)

        threading.Thread(target=_worker, name="appcatch-catch", daemon=True).start()

    def _on_catch_finished(
        self,
        token: int,
        mode: str,
        info: WindowInfo,
        session,
        err: Exception | None,
    ) -> None:
        """Apply catch result on the Qt UI thread."""
        try:
            if token != self._catch_token:
                # Stale: user switched apps mid-catch
                return
            if err is not None or session is None:
                proc = (info.process_name or "?").replace(".exe", "")
                self.toast.show_message(f"抓取失败 · {proc}: {err or '无会话'}")
                self.tray.set_status("red")
                return

            n = len(session.candidates)
            proc = (info.process_name or "?").replace(".exe", "")
            self.toast.show_message(f"目标: {proc} · 候选 {n}")

            try:
                self._apply_catch_session(mode, info, session)
            except Exception as e:
                traceback.print_exc()
                self.toast.show_message(f"抓取失败 · {proc}: {e}")
                self.tray.set_status("red")
        finally:
            if token == self._catch_token:
                self._busy = False
                self.check_health()

    def _apply_catch_session(self, mode: str, info: WindowInfo, session) -> None:
        """UI decisions after session is built (always main thread)."""
        proc_l = (info.process_name or "").lower()
        is_discord = "discord" in proc_l

        if mode == "screenshot":
            self.pipeline.ensure_screenshot(info, session)
            shot = session.candidates[-1]
            item = self.pipeline.ingest_candidate(
                shot,
                restricted=bool(self.cfg.get("ingest", "restricted")),
                use_jasna=False,
                materialize_first=False,
            )
            self._report_item(item)
            self.panel.refresh_recent()
            return

        if mode == "grid":
            if not any(not c.filtered_out for c in session.candidates) and self.cfg.get(
                "ui", "allow_screenshot_fallback", True
            ):
                self.pipeline.ensure_screenshot(info, session)
            self.pipeline.auto_select_quality(session)
            self._open_grid(session, toast_summary=True)
            return

        # Smart catch: ALWAYS open grid — user confirms before any ingest.
        # (mode=="screenshot" above still one-shots; that is an explicit hotkey action.)
        decision = self.pipeline.decide_ui(session)
        summary = session_summary(session.candidates)
        if decision == "screenshot_fallback" or not any(
            not c.filtered_out for c in session.candidates
        ):
            if self.cfg.get("ui", "allow_screenshot_fallback", True):
                self.pipeline.ensure_screenshot(info, session)
        self.pipeline.auto_select_quality(session)
        # Never auto-select for user — grid opens with nothing pre-checked
        for c in session.candidates:
            c.selected = False
        self._open_grid(session, toast_summary=True)
        tip = summary.get("headline") or ""
        only_shot = not any(
            c.source_kind != SourceKind.SCREENSHOT and not c.filtered_out
            for c in session.candidates
        )
        if decision == "screenshot_fallback" or only_shot:
            if is_discord:
                self.toast.show_message(
                    f"{tip or '暂无原片'}\n"
                    "Discord：① 右键视频→复制链接→再点抓取\n"
                    "② 另存到「下载」后抓  ③ 网格勾选后入库"
                )
            else:
                self.toast.show_message(
                    f"{tip or '暂无原片'}\n"
                    "请在网格中勾选确认后再入库；可截图入库，或先复制链接/另存后再抓"
                )

    def _open_grid(self, session, *, toast_summary: bool = False) -> None:
        self.grid.open_session(
            session,
            restricted=bool(self.cfg.get("ingest", "restricted")),
            use_jasna=bool(self.cfg.get("ingest", "use_jasna")),
        )
        if toast_summary:
            hl = self.pipeline.session_headline(session)
            if hl:
                self.toast.show_message(hl)

    def _grid_add_shot(self) -> None:
        info = self._target
        if not info or not self.grid._session:
            self.toast.show_message("无目标窗口")
            return
        try:
            shot = self.pipeline.ensure_screenshot(info, self.grid._session)
            shot.selected = True
            self.grid.append_candidate(shot)
        except Exception as e:
            self.toast.show_message(f"截图失败: {e}")

    def _ingest_list(self, cands, restricted: bool, jasna: bool, tags: list) -> None:
        total = len(cands)
        ok = fail = dup = 0
        for i, c in enumerate(cands, 1):
            self.grid.set_progress(i - 1, total, label=f"入库 {i}/{total}…")
            item = self.pipeline.ingest_candidate(
                c, restricted=restricted, use_jasna=jasna, extra_tags=tags
            )
            if item.status == "success":
                ok += 1
            elif item.status == "duplicate":
                dup += 1
            else:
                fail += 1
            # refresh card grade if materialized
            try:
                self.grid.refresh_candidate(c)
            except Exception:
                pass
        self.grid.set_progress(total, total)
        self.panel.refresh_recent()
        msg = f"入库完成：成功 {ok} · 重复 {dup} · 失败 {fail}"
        if ok or dup:
            msg += "\n可点主面板「打开媒体库」查看"
        self.toast.show_message(msg)
        if fail == 0 and (ok or dup):
            self.grid.close()

    def _download_list(self, cands: list) -> None:
        """Materialize on a plain thread; UI polls progress every 100ms."""
        if not cands:
            self.toast.show_message("没有可下载的链接")
            return
        if self._dl_job is not None and self._dl_job.is_running():
            self.toast.show_message("已有下载任务在进行")
            return
        self.grid._busy_download = True
        self.grid.btn_download.setEnabled(False)
        self.grid.set_progress(0, 1000, label=f"准备下载 {len(cands)} 项…", auto_hide=False)
        self.toast.show_message(f"后台下载 {len(cands)} 项…进度条每 0.1s 刷新")

        def materialize_fn(c, progress_cb=None):
            return self.pipeline.materialize(c, progress_cb=progress_cb)

        self._dl_job = DownloadJob(materialize_fn, cands)
        self._dl_job.start()
        self._dl_poll.start()

    def _poll_download_progress(self) -> None:
        job = self._dl_job
        if job is None:
            self._dl_poll.stop()
            return
        snap = job.snapshot()
        self.grid.set_progress(
            snap.value, snap.maximum, label=snap.label or "下载中…", auto_hide=False
        )
        if not snap.done and job.is_running():
            return
        # finished
        self._dl_poll.stop()
        self.grid._busy_download = False
        self.grid.btn_download.setEnabled(True)
        self.grid.set_progress(
            1000,
            1000,
            label=snap.label or f"完成：成功 {snap.ok} · 失败 {snap.fail}",
            auto_hide=True,
        )
        self.toast.show_message(
            f"下载完成：成功 {snap.ok} · 失败 {snap.fail}\n"
            "点「播放（系统播放器）」或「打开所在文件夹」"
        )
        # Soft UI only — no apply_grades-all, no rebuild (those freezed the grid)
        try:
            if self.grid._session:
                sm = session_summary(self.grid._session.candidates)
                self.grid.header.setText(sm.get("headline") or self.grid.header.text())
                # update focused card meta if any downloaded
                if self.grid._current_id:
                    cur = self.grid._find(self.grid._current_id)
                    if cur:
                        self.grid.soft_update_candidate(cur)
                        self.grid._focus(cur.id)
        except Exception:
            traceback.print_exc()
        self._dl_job = None

    def _report_item(self, item) -> None:
        if item.status == "success":
            mid = f" #{item.media_id}" if item.media_id else ""
            local = " · 已落盘" if item.local_path else ""
            self.toast.show_message(f"已入库{mid}{local} · {item.title[:40]}\n主面板可打开媒体库")
        elif item.status == "duplicate":
            self.toast.show_message("库里已有相同内容，跳过")
        else:
            self.toast.show_message(f"入库失败：{item.error}")


def main() -> None:
    # High DPI
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        __import__("PySide6.QtCore", fromlist=["Qt"]).Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setApplicationName("AppCatch")

    if not QApplication.instance():  # pragma: no cover
        pass

    try:
        from PySide6.QtWidgets import QSystemTrayIcon

        if not QSystemTrayIcon.isSystemTrayAvailable():
            QMessageBox.critical(None, "AppCatch", "系统托盘不可用")
            sys.exit(1)
    except Exception:
        pass

    _ctrl = AppController(app)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
