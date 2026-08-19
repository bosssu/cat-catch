from __future__ import annotations

import os
import sys
from typing import Callable

from app.core.models import WindowInfo

if sys.platform == "win32":
    import win32con
    import win32gui
    import win32process


def _process_name(pid: int | None) -> str:
    if not pid:
        return ""
    try:
        import win32api

        h = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        try:
            try:
                import ctypes
                from ctypes import wintypes

                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                buf = ctypes.create_unicode_buffer(32768)
                size = wintypes.DWORD(len(buf))
                ok = kernel32.QueryFullProcessImageNameW(int(h), 0, buf, ctypes.byref(size))
                if ok:
                    return buf.value.split("\\")[-1]
            except Exception:
                pass
            return win32process.GetModuleFileNameEx(h, 0).split("\\")[-1]
        finally:
            win32api.CloseHandle(h)
    except Exception:
        try:
            import psutil

            return psutil.Process(pid).name()
        except Exception:
            return f"pid{pid}"


def window_from_point(x: int, y: int) -> WindowInfo | None:
    if sys.platform != "win32":
        return None
    try:
        hwnd = win32gui.WindowFromPoint((int(x), int(y)))
    except Exception:
        return None
    if not hwnd:
        return None
    try:
        root = win32gui.GetAncestor(hwnd, win32con.GA_ROOT)
        if root:
            hwnd = root
    except Exception:
        pass
    try:
        if not win32gui.IsWindowVisible(hwnd):
            return None
    except Exception:
        return None
    try:
        title = win32gui.GetWindowText(hwnd) or ""
        _tid, pid = win32process.GetWindowThreadProcessId(hwnd)
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        if right - left < 40 or bottom - top < 40:
            return None
        name = _process_name(pid)
        return WindowInfo(
            hwnd=int(hwnd),
            pid=int(pid) if pid else None,
            process_name=name,
            title=title,
            rect=(int(left), int(top), int(right), int(bottom)),
        )
    except Exception:
        return None


def is_ignored(
    info: WindowInfo,
    ignore_names: list[str],
    self_pids: set[int] | None = None,
) -> bool:
    if self_pids and info.pid in self_pids:
        return True
    base = (info.process_name or "").lower().removesuffix(".exe")
    # Exact match only (startswith caused accidental ignores)
    ignore_set = {n.lower().removesuffix(".exe") for n in ignore_names if n}
    if base in ignore_set:
        return True
    if not info.process_name and not info.title:
        return True
    try:
        cls = win32gui.GetClassName(info.hwnd)
    except Exception:
        cls = ""
    if cls in ("Progman", "WorkerW", "Shell_TrayWnd"):
        return True
    return False


class HoverTracker:
    """Poll cursor; emit window when dwell satisfied. Sticky hide when leaving briefly."""

    def __init__(
        self,
        dwell_ms: int = 350,
        poll_ms: int = 80,
        sticky_ms: int = 1500,
        ignore_names: list[str] | None = None,
        self_pids: set[int] | None = None,
        on_target: Callable[[WindowInfo | None], None] | None = None,
    ):
        self.dwell_ms = dwell_ms
        self.poll_ms = poll_ms
        # Keep last target this long after cursor leaves (so button stays clickable)
        self.sticky_ms = sticky_ms
        self.ignore_names = ignore_names or []
        self.self_pids = self_pids or {os.getpid()}
        self.on_target = on_target
        self.overlay_hwnds: set[int] = set()
        self._stable_hwnd: int | None = None
        self._stable_since_ms: float = 0
        self._last_emitted: int | None = None
        self._last_info: WindowInfo | None = None
        self._leave_since_ms: float | None = None
        self._enabled = True
        self.debug_last: str = ""

    def set_enabled(self, on: bool) -> None:
        self._enabled = on
        if not on and self.on_target:
            self._last_info = None
            self._leave_since_ms = None
            self.on_target(None)

    def register_overlay_hwnd(self, hwnd: int | None) -> None:
        if hwnd:
            self.overlay_hwnds.add(int(hwnd))

    def _is_overlay_hwnd(self, hwnd: int | None) -> bool:
        if not hwnd:
            return False
        if int(hwnd) in self.overlay_hwnds:
            return True
        # Also match if root of hwnd is our overlay (child hit-tests)
        try:
            root = win32gui.GetAncestor(int(hwnd), win32con.GA_ROOT)
            if root and int(root) in self.overlay_hwnds:
                return True
        except Exception:
            pass
        return False

    def _hold_last(self, now_ms: float, reason: str) -> bool:
        """If we have a last target and sticky window not expired, keep emitting it."""
        if self._last_info is None:
            return False
        if self._leave_since_ms is None:
            self._leave_since_ms = now_ms
        elapsed = now_ms - self._leave_since_ms
        if elapsed < self.sticky_ms:
            self.debug_last = f"{reason} sticky {int(self.sticky_ms - elapsed)}ms→{self._last_info.process_name}"
            if self.on_target:
                self.on_target(self._last_info)
            return True
        return False

    def _clear_target(self, reason: str) -> None:
        self._stable_hwnd = None
        self._last_emitted = None
        self._last_info = None
        self._leave_since_ms = None
        self.debug_last = reason
        if self.on_target:
            self.on_target(None)

    def tick(self, now_ms: float) -> None:
        if not self._enabled or sys.platform != "win32":
            return
        try:
            x, y = win32gui.GetCursorPos()
        except Exception:
            return

        # Raw hwnd under cursor (before GA_ROOT) for overlay hit-test
        raw_hwnd = 0
        try:
            raw_hwnd = int(win32gui.WindowFromPoint((int(x), int(y))) or 0)
        except Exception:
            raw_hwnd = 0

        # Over our floating catch button → keep last target; cancel leave timer
        if self._is_overlay_hwnd(raw_hwnd):
            self._leave_since_ms = None
            self.debug_last = (
                f"on-button→{self._last_info.process_name}" if self._last_info else "on-button"
            )
            if self._last_info is not None and self.on_target:
                if self._last_emitted != self._last_info.hwnd:
                    self._last_emitted = self._last_info.hwnd
                self.on_target(self._last_info)
            return

        info = window_from_point(x, y)

        # Also treat resolved root as overlay if registered
        if info is not None and self._is_overlay_hwnd(info.hwnd):
            self._leave_since_ms = None
            if self._last_info is not None and self.on_target:
                self.on_target(self._last_info)
            return

        if info is None or is_ignored(info, self.ignore_names, self.self_pids):
            reason = f"ignored:{info.process_name}" if info else "no-window"
            if self._hold_last(now_ms, reason):
                return
            self._clear_target(reason)
            return

        # Cursor is on a real app window again
        self.debug_last = f"{info.process_name} pid={info.pid}"

        if info.hwnd != self._stable_hwnd:
            # Start dwell on the new hwnd. Sticky only applies when leaving to
            # desktop/ignored — NOT when the user is clearly over another app.
            self._stable_hwnd = info.hwnd
            self._stable_since_ms = now_ms
            # Re-entered same sticky target → restore immediately
            if self._last_info is not None and info.hwnd == self._last_info.hwnd:
                self._leave_since_ms = None
                self._last_emitted = info.hwnd
                self._last_info = info
                if self.on_target:
                    self.on_target(info)
                return
            # Different real app: drop old target right away so UI does not keep
            # showing Discord while cursor is already on Steam / cloudmusic / etc.
            if self._last_info is not None and info.hwnd != self._last_info.hwnd:
                self._leave_since_ms = None
                old = self._last_info.process_name or "?"
                self.debug_last = f"switch {old}→{info.process_name} dwell…"
                self._last_emitted = None
                self._last_info = None
                if self.on_target:
                    self.on_target(None)
            return

        if now_ms - self._stable_since_ms < self.dwell_ms:
            self.debug_last += " dwell…"
            return

        # Dwell satisfied — lock new target
        self._leave_since_ms = None
        self._last_emitted = info.hwnd
        self._last_info = info
        if self.on_target:
            self.on_target(info)
