from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
    QMessageBox,
)

from app.core.config import AppConfig
from app.extensions.loader import ExtensionRegistry
from app.lmw.client import LmwClient
from app.state.recent_store import RecentStore


class MainPanel(QWidget):
    pause_changed = Signal(bool)
    config_changed = Signal()
    open_library = Signal()
    test_connection = Signal()
    reload_extensions = Signal()

    def __init__(self, cfg: AppConfig, lmw: LmwClient, recent: RecentStore, registry: ExtensionRegistry):
        super().__init__()
        self.cfg = cfg
        self.lmw = lmw
        self.recent = recent
        self.registry = registry
        self.setWindowTitle("AppCatch")
        self.resize(420, 640)
        self.setStyleSheet(
            """
            QWidget { background: #f4f4f4; color: #222; font-size: 13px; }
            QGroupBox { font-weight: 600; margin-top: 8px; }
            QPushButton { padding: 6px 10px; }
            """
        )

        outer = QVBoxLayout(self)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        body = QWidget()
        root = QVBoxLayout(body)

        # status
        top = QHBoxLayout()
        self.status = QLabel("● 检测中…")
        self.status.setStyleSheet("font-weight:600;")
        top.addWidget(self.status)
        top.addStretch()
        root.addLayout(top)

        self.hover_debug = QLabel("悬停探测：等待鼠标移到其它窗口…")
        self.hover_debug.setWordWrap(True)
        self.hover_debug.setStyleSheet("color:#555;font-size:12px;padding:4px 0;")
        root.addWidget(self.hover_debug)

        tip = QLabel(
            "用法：悬停目标窗口 → 内侧偏下出现抓取钮（不挡关闭键）→ 单击抓取；"
            "移出窗口后按钮会短暂停留便于点击；按住可拖动。"
            "绿=原片 / 蓝=链接 / 黄=截图。Discord 可先复制链接再抓。"
        )
        tip.setWordWrap(True)
        tip.setStyleSheet("color:#666;font-size:11px;")
        root.addWidget(tip)

        row = QHBoxLayout()
        b_lib = QPushButton("打开媒体库")
        b_lib.clicked.connect(self.open_library.emit)
        self.b_pause = QPushButton("暂停抓取")
        self.b_pause.setCheckable(True)
        self.b_pause.toggled.connect(self._on_pause)
        row.addWidget(b_lib)
        row.addWidget(self.b_pause)
        root.addLayout(row)

        # recent
        g_recent = QGroupBox("最近抓取")
        rl = QVBoxLayout(g_recent)
        head = QHBoxLayout()
        head.addStretch()
        b_clear = QPushButton("清空显示")
        b_clear.clicked.connect(self._clear_recent)
        head.addWidget(b_clear)
        rl.addLayout(head)
        self.recent_list = QListWidget()
        self.recent_list.setMinimumHeight(160)
        rl.addWidget(self.recent_list)
        root.addWidget(g_recent)

        # filter
        g_f = QGroupBox("过滤")
        g_f.setCheckable(True)
        g_f.setChecked(False)
        fl = QFormLayout(g_f)
        self.spin_edge = QSpinBox()
        self.spin_edge.setRange(0, 4000)
        self.spin_edge.setValue(int(cfg.get("capture", "min_edge_px", default=200)))
        self.spin_bytes = QSpinBox()
        self.spin_bytes.setRange(0, 50_000_000)
        self.spin_bytes.setValue(int(cfg.get("capture", "min_bytes", default=10240)))
        self.chk_avatar = QCheckBox("跳过明显头像/emoji 尺寸")
        self.chk_avatar.setChecked(bool(cfg.get("capture", "skip_avatar_like", default=True)))
        self.chk_img = QCheckBox("图")
        self.chk_gif = QCheckBox("动图")
        self.chk_vid = QCheckBox("视频")
        self.chk_aud = QCheckBox("音频")
        types = set(cfg.get("capture", "types", default=[]) or [])
        self.chk_img.setChecked("image" in types or not types)
        self.chk_gif.setChecked("gif" in types or not types)
        self.chk_vid.setChecked("video" in types or not types)
        self.chk_aud.setChecked("audio" in types)
        fl.addRow("最小边长 px", self.spin_edge)
        fl.addRow("最小文件 字节", self.spin_bytes)
        fl.addRow(self.chk_avatar)
        trow = QHBoxLayout()
        for c in (self.chk_img, self.chk_gif, self.chk_vid, self.chk_aud):
            trow.addWidget(c)
        fl.addRow("类型", trow)
        root.addWidget(g_f)
        self._g_filter = g_f

        # ingest
        g_i = QGroupBox("入库选项")
        g_i.setCheckable(True)
        g_i.setChecked(False)
        il = QFormLayout(g_i)
        self.tags_edit = QLineEdit(",".join(cfg.get("ingest", "default_tags", default=[]) or []))
        self.chk_restricted = QCheckBox("限制级")
        self.chk_restricted.setChecked(bool(cfg.get("ingest", "restricted", default=False)))
        self.chk_jasna = QCheckBox("视频 jasna 去马赛克")
        self.chk_jasna.setChecked(bool(cfg.get("ingest", "use_jasna", default=False)))
        self.chk_one = QCheckBox("单候选一键入库（不推荐：跳过确认网格）")
        self.chk_one.setChecked(bool(cfg.get("ui", "one_click_when_single", default=False)))
        self.chk_one.setToolTip("关闭时（推荐）：无论几条候选都打开网格，勾选后再入库")
        self.chk_fallback = QCheckBox("无原片时截图兜底")
        self.chk_fallback.setChecked(bool(cfg.get("ui", "allow_screenshot_fallback", default=True)))
        il.addRow("默认标签", self.tags_edit)
        il.addRow(self.chk_restricted)
        il.addRow(self.chk_jasna)
        il.addRow(self.chk_one)
        il.addRow(self.chk_fallback)
        root.addWidget(g_i)

        # extensions
        g_e = QGroupBox("扩展")
        g_e.setCheckable(True)
        g_e.setChecked(False)
        el = QVBoxLayout(g_e)
        erow = QHBoxLayout()
        self.ext_summary = QLabel("")
        erow.addWidget(self.ext_summary)
        erow.addStretch()
        b_open_ext = QPushButton("打开扩展目录")
        b_open_ext.clicked.connect(self._open_ext_dir)
        b_reload = QPushButton("重新加载")
        b_reload.clicked.connect(self.reload_extensions.emit)
        erow.addWidget(b_open_ext)
        erow.addWidget(b_reload)
        el.addLayout(erow)
        self.ext_list = QListWidget()
        self.ext_list.setMinimumHeight(100)
        el.addWidget(self.ext_list)
        tip = QLabel("补齐新 App：复制 extensions/_template → 改进程名与 CDN 规则 → 重新加载")
        tip.setWordWrap(True)
        tip.setStyleSheet("color:#666;font-size:11px;")
        el.addWidget(tip)
        root.addWidget(g_e)
        self._g_ext = g_e

        # settings
        g_s = QGroupBox("设置")
        g_s.setCheckable(True)
        g_s.setChecked(False)
        sl = QFormLayout(g_s)
        self.url_edit = QLineEdit(cfg.get("lmw", "base_url", default="http://127.0.0.1:8790"))
        self.token_edit = QLineEdit(cfg.get("lmw", "token", default="") or "")
        self.token_edit.setEchoMode(QLineEdit.EchoMode.PasswordEchoOnEdit)
        self.chk_hover = QCheckBox("悬停显示抓取按钮")
        self.chk_hover.setChecked(bool(cfg.get("ui", "show_hover_button", default=True)))
        self.spin_dwell = QSpinBox()
        self.spin_dwell.setRange(100, 2000)
        self.spin_dwell.setValue(int(cfg.get("ui", "hover_dwell_ms", default=350)))
        b_test = QPushButton("测试连接")
        b_test.clicked.connect(self.test_connection.emit)
        b_save = QPushButton("保存设置")
        b_save.clicked.connect(self.save_settings)
        # demo multi for testing grid
        b_demo = QPushButton("调试：下次抓取注入多候选")
        b_demo.setToolTip("方便测试网格面板，无需网络哨兵")
        self._demo_multi = False
        b_demo.clicked.connect(self._toggle_demo)
        self._b_demo = b_demo
        sl.addRow("媒体库地址", self.url_edit)
        sl.addRow("Token", self.token_edit)
        sl.addRow(self.chk_hover)
        sl.addRow("悬停防抖 ms", self.spin_dwell)
        sl.addRow(b_test)
        sl.addRow(b_save)
        sl.addRow(b_demo)
        root.addWidget(g_s)

        root.addStretch()
        self.footer = QLabel("AppCatch v0.1")
        self.footer.setStyleSheet("color:#888;font-size:11px;")
        root.addWidget(self.footer)

        scroll.setWidget(body)
        outer.addWidget(scroll)

        self.refresh_recent()
        self.refresh_extensions()

    def _on_pause(self, paused: bool) -> None:
        self.b_pause.setText("继续抓取" if paused else "暂停抓取")
        self.pause_changed.emit(paused)

    def set_lmw_ok(self, ok: bool, detail: str = "") -> None:
        if ok:
            self.status.setText("● 已连接媒体库")
            self.status.setStyleSheet("font-weight:600;color:#0a0;")
        else:
            self.status.setText("● 媒体库未连接")
            self.status.setStyleSheet("font-weight:600;color:#c00;")
            if detail:
                self.status.setToolTip(detail)

    def set_hover_debug(self, text: str) -> None:
        self.hover_debug.setText(f"悬停探测：{text}")

    def refresh_recent(self) -> None:
        self.recent_list.clear()
        for it in self.recent.items:
            flag = {"success": "✓", "duplicate": "≈", "fail": "✗"}.get(it.status, "?")
            mid = f" #{it.media_id}" if it.media_id else ""
            err = f" — {it.error}" if it.error else ""
            text = f"{flag} {it.title[:40]}{mid} · {it.process_name}{err}"
            self.recent_list.addItem(QListWidgetItem(text))

    def refresh_extensions(self) -> None:
        self.ext_list.clear()
        en = dis = 0
        for e in self.registry.extensions:
            if e.is_template:
                mark = "□"
                state = "模板"
            elif e.enabled:
                mark = "●"
                en += 1
                state = "启用"
            else:
                mark = "○"
                dis += 1
                state = "禁用"
            err = f" !{e.error}" if e.error else ""
            kind = "内置" if e.is_builtin else ("模板" if e.is_template else "扩展")
            self.ext_list.addItem(f"{mark} {e.id}  {e.name}  [{kind}/{state}]{err}")
        self.ext_summary.setText(f"已启用 {en} · 其它 {dis}")

    def _clear_recent(self) -> None:
        self.recent.clear_display()
        self.refresh_recent()

    def _open_ext_dir(self) -> None:
        path = self.cfg.extensions_dir()
        path.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", str(path)])

    def _toggle_demo(self) -> None:
        self._demo_multi = not self._demo_multi
        self._b_demo.setText(
            "调试：多候选 ON（再点关闭）" if self._demo_multi else "调试：下次抓取注入多候选"
        )

    @property
    def demo_multi(self) -> bool:
        return self._demo_multi

    def save_settings(self) -> None:
        self.cfg.set("lmw", "base_url", self.url_edit.text().strip())
        self.cfg.set("lmw", "token", self.token_edit.text().strip())
        self.cfg.set("ui", "show_hover_button", self.chk_hover.isChecked())
        self.cfg.set("ui", "hover_dwell_ms", self.spin_dwell.value())
        self.cfg.set("ui", "one_click_when_single", self.chk_one.isChecked())
        self.cfg.set("ui", "allow_screenshot_fallback", self.chk_fallback.isChecked())
        self.cfg.set("capture", "min_edge_px", self.spin_edge.value())
        self.cfg.set("capture", "min_bytes", self.spin_bytes.value())
        self.cfg.set("capture", "skip_avatar_like", self.chk_avatar.isChecked())
        types = []
        if self.chk_img.isChecked():
            types.append("image")
        if self.chk_gif.isChecked():
            types.append("gif")
        if self.chk_vid.isChecked():
            types.append("video")
        if self.chk_aud.isChecked():
            types.append("audio")
        self.cfg.set("capture", "types", types)
        tags = [t.strip() for t in self.tags_edit.text().split(",") if t.strip()]
        self.cfg.set("ingest", "default_tags", tags)
        self.cfg.set("ingest", "restricted", self.chk_restricted.isChecked())
        self.cfg.set("ingest", "use_jasna", self.chk_jasna.isChecked())
        self.cfg.save()
        self.config_changed.emit()
        QMessageBox.information(self, "AppCatch", "设置已保存")

    def focus_extensions(self) -> None:
        self._g_ext.setChecked(True)
        self.show()
        self.raise_()
