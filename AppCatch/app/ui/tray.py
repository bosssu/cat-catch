from __future__ import annotations

from PySide6.QtGui import QAction, QColor, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QSystemTrayIcon, QMenu


def make_dot_icon(color: str = "#888888") -> QIcon:
    pm = QPixmap(64, 64)
    pm.fill(QColor(0, 0, 0, 0))
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QColor(color))
    p.setPen(QColor("#222222"))
    p.drawEllipse(8, 8, 48, 48)
    p.end()
    return QIcon(pm)


class TrayController:
    def __init__(self, app_name: str = "AppCatch"):
        self.tray = QSystemTrayIcon(make_dot_icon("#888888"))
        self.tray.setToolTip(app_name)
        self.menu = QMenu()
        self.act_panel = QAction("打开面板")
        self.act_lib = QAction("打开媒体库")
        self.act_pause = QAction("暂停抓取")
        self.act_pause.setCheckable(True)
        self.act_ext = QAction("扩展管理")
        self.act_quit = QAction("退出")
        self.menu.addAction(self.act_panel)
        self.menu.addAction(self.act_lib)
        self.menu.addAction(self.act_pause)
        self.menu.addAction(self.act_ext)
        self.menu.addSeparator()
        self.menu.addAction(self.act_quit)
        self.tray.setContextMenu(self.menu)
        self.tray.show()

    def set_status(self, kind: str) -> None:
        colors = {
            "gray": "#888888",
            "green": "#22aa44",
            "orange": "#ee8800",
            "red": "#cc2222",
        }
        self.tray.setIcon(make_dot_icon(colors.get(kind, "#888888")))

    def notify(self, title: str, msg: str) -> None:
        self.tray.showMessage(title, msg, QSystemTrayIcon.MessageIcon.Information, 2500)
