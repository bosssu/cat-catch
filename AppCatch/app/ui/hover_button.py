from __future__ import annotations

import sys

from PySide6.QtCore import Qt, Signal, QPoint, QRectF
from PySide6.QtGui import (
    QCursor,
    QAction,
    QGuiApplication,
    QPainter,
    QColor,
    QPen,
    QBrush,
    QPainterPath,
    QFont,
)
from PySide6.QtWidgets import QMenu, QWidget

from app.core.models import WindowInfo


def _physical_to_qt(px: int, py: int) -> QPoint:
    """Map Win32 physical pixels to Qt global logical coords."""
    screens = QGuiApplication.screens()
    if not screens:
        return QPoint(px, py)
    for screen in screens:
        g = screen.geometry()
        dpr = float(screen.devicePixelRatio())
        left = int(g.x() * dpr)
        top = int(g.y() * dpr)
        right = left + int(g.width() * dpr)
        bottom = top + int(g.height() * dpr)
        if left <= px < right and top <= py < bottom:
            lx = g.x() + int((px - left) / dpr)
            ly = g.y() + int((py - top) / dpr)
            return QPoint(lx, ly)
    screen = QGuiApplication.primaryScreen()
    dpr = float(screen.devicePixelRatio()) if screen else 1.0
    return QPoint(int(px / dpr), int(py / dpr))


class HoverCatchButton(QWidget):
    """Floating pill: inside target window (right, below title bar); hold-drag; click to catch."""

    clicked_catch = Signal()
    clicked_screenshot = Signal()
    clicked_grid = Signal()
    clicked_boost = Signal()
    clicked_clipboard = Signal()

    def __init__(self):
        flags = (
            Qt.WindowType.Tool
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.WindowDoesNotAcceptFocus
        )
        super().__init__(None, flags)
        self.setObjectName("AppCatchHoverButton")
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, True)
        self.setWindowOpacity(1.0)
        self.setCursor(QCursor(Qt.CursorShape.SizeAllCursor))
        self.setFixedHeight(38)

        self._text = "⬇ 截取"
        self._hover = False
        self._info: WindowInfo | None = None
        self._count = 0
        self._anchored_hwnd: int | None = None
        self._placed = False
        self._user_dragged = False  # keep user position until target hwnd changes

        self._press_global: QPoint | None = None
        self._press_win: QPoint | None = None
        self._dragging = False
        self._drag_threshold = 6

        self.hide()

    def native_hwnd(self) -> int | None:
        if sys.platform != "win32":
            return None
        try:
            return int(self.winId())
        except Exception:
            return None

    def set_target(
        self,
        info: WindowInfo | None,
        count: int = 0,
        level: str = "截取",
        *,
        force_reposition: bool = False,
    ) -> None:
        self._info = info
        self._count = count
        if info is None or not info.hwnd:
            self._anchored_hwnd = None
            self._placed = False
            self._user_dragged = False
            self.hide()
            return

        suffix = f" ·{count}" if count > 0 else ""
        proc = (info.process_name or "").replace(".exe", "")[:14]
        self._text = f"⬇ {level}{suffix}  {proc}"
        # size from text
        fm_w = max(120, len(self._text) * 9 + 28)
        self.setFixedWidth(fm_w)
        self.update()

        hwnd_changed = self._anchored_hwnd != info.hwnd
        if hwnd_changed:
            self._user_dragged = False
            self._placed = False

        need_place = force_reposition or not self._placed or hwnd_changed or not self.isVisible()
        if need_place and not self._user_dragged:
            self._place_inside_window(info)
            self._anchored_hwnd = info.hwnd
            self._placed = True
        elif hwnd_changed:
            self._anchored_hwnd = info.hwnd

        self._force_topmost()
        if not self.isVisible():
            self.show()
        else:
            self.raise_()

    def _place_inside_window(self, info: WindowInfo) -> None:
        """
        Default: INSIDE target window, right edge, below title bar / close button.
        Offset ~88–120px from top so we don't cover the caption controls.
        """
        left, top, right, bottom = info.rect
        w = self.width() or 140
        h = self.height() or 38
        margin = 12

        tl = _physical_to_qt(left, top)
        tr = _physical_to_qt(right, top)
        br = _physical_to_qt(right, bottom)

        win_left, win_top = tl.x(), tl.y()
        win_right = tr.x()
        win_bottom = br.y()
        win_w = max(80, win_right - win_left)
        win_h = max(80, win_bottom - win_top)

        # Below typical title bar (~32–40) and a bit lower so close/min are free.
        # For tall windows use ~100px; short windows clamp into content area.
        top_offset = 96
        if win_h < 200:
            top_offset = max(48, min(72, win_h // 4))
        elif win_h > 600:
            top_offset = 110

        x = win_right - w - margin
        y = win_top + top_offset

        # Keep fully inside window bounds
        if x < win_left + margin:
            x = win_left + margin
        if y + h > win_bottom - margin:
            y = max(win_top + margin, win_bottom - h - margin)
        if y < win_top + 48:
            # still prefer below caption if possible
            y = min(win_top + 48, max(win_top + margin, win_bottom - h - margin))

        # Also clamp to screen available geometry
        screen = QGuiApplication.screenAt(QPoint(win_left, win_top)) or QGuiApplication.primaryScreen()
        if screen:
            g = screen.availableGeometry()
            x = min(max(g.left() + 2, x), g.right() - w - 2)
            y = min(max(g.top() + 2, y), g.bottom() - h - 2)

        # narrow windows: center-ish right half
        if win_w < w + margin * 2:
            x = win_left + max(0, (win_w - w) // 2)

        self.move(int(x), int(y))

    def _force_topmost(self) -> None:
        if sys.platform != "win32":
            self.raise_()
            return
        try:
            import win32con
            import win32gui

            hwnd = int(self.winId())
            win32gui.SetWindowPos(
                hwnd,
                win32con.HWND_TOPMOST,
                0,
                0,
                0,
                0,
                win32con.SWP_NOMOVE
                | win32con.SWP_NOSIZE
                | win32con.SWP_SHOWWINDOW
                | win32con.SWP_NOACTIVATE,
            )
        except Exception:
            self.raise_()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = QRectF(1, 1, self.width() - 2, self.height() - 2)
        path = QPainterPath()
        path.addRoundedRect(rect, 16, 16)
        bg = QColor("#0078d7") if self._hover else QColor("#1e1e1e")
        p.fillPath(path, QBrush(bg))
        p.setPen(QPen(QColor("#3aa0ff"), 2))
        p.drawPath(path)
        p.setPen(QColor("#ffffff"))
        font = QFont()
        font.setBold(True)
        font.setPointSize(10)
        p.setFont(font)
        p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self._text)
        p.end()

    def enterEvent(self, event) -> None:  # noqa: N802
        self._hover = True
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.update()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hover = False
        self.setCursor(QCursor(Qt.CursorShape.SizeAllCursor))
        self.update()
        super().leaveEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_global = event.globalPosition().toPoint()
            self._press_win = self.pos()
            self._dragging = False
            event.accept()
            return
        if event.button() == Qt.MouseButton.MiddleButton:
            self.clicked_screenshot.emit()
            event.accept()
            return
        if event.button() == Qt.MouseButton.RightButton:
            self._show_menu(event.globalPosition().toPoint())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._press_global is not None and event.buttons() & Qt.MouseButton.LeftButton:
            delta = event.globalPosition().toPoint() - self._press_global
            if not self._dragging and (abs(delta.x()) > self._drag_threshold or abs(delta.y()) > self._drag_threshold):
                self._dragging = True
                self.setCursor(QCursor(Qt.CursorShape.SizeAllCursor))
            if self._dragging and self._press_win is not None:
                self.move(self._press_win + delta)
                self._user_dragged = True
                self._placed = True
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            if self._press_global is not None and not self._dragging:
                self.clicked_catch.emit()
            self._press_global = None
            self._press_win = None
            self._dragging = False
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def _show_menu(self, global_pos: QPoint) -> None:
        menu = QMenu(None)
        menu.setWindowFlags(
            menu.windowFlags() | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool
        )
        menu.setStyleSheet(
            """
            QMenu {
                background-color: #f5f5f5;
                color: #111111;
                border: 1px solid #888;
                padding: 4px;
                font-size: 13px;
            }
            QMenu::item {
                background-color: transparent;
                color: #111111;
                padding: 8px 28px 8px 16px;
            }
            QMenu::item:selected {
                background-color: #0078d7;
                color: #ffffff;
            }
            QMenu::separator {
                height: 1px;
                background: #ccc;
                margin: 4px 8px;
            }
            """
        )
        a1 = QAction("智能抓取", menu)
        a1.triggered.connect(self.clicked_catch.emit)
        a2 = QAction("截图入库", menu)
        a2.triggered.connect(self.clicked_screenshot.emit)
        a3 = QAction("打开候选网格", menu)
        a3.triggered.connect(self.clicked_grid.emit)
        a4 = QAction("从剪贴板抓链接/文件", menu)
        a4.triggered.connect(self.clicked_clipboard.emit)
        a5 = QAction("对该窗口加强 30 秒", menu)
        a5.triggered.connect(self.clicked_boost.emit)
        a6 = QAction("重置按钮位置", menu)
        a6.triggered.connect(self._reset_position)
        menu.addAction(a1)
        menu.addAction(a2)
        menu.addAction(a3)
        menu.addAction(a4)
        menu.addSeparator()
        menu.addAction(a5)
        menu.addAction(a6)
        menu.exec(global_pos)
        menu.deleteLater()

    def _reset_position(self) -> None:
        self._user_dragged = False
        if self._info:
            self._place_inside_window(self._info)
            self._placed = True
            self._force_topmost()
