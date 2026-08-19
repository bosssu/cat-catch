from __future__ import annotations

import os
import subprocess
import sys
import webbrowser
from pathlib import Path

from PySide6.QtCore import Qt, Signal, QTimer
from PySide6.QtGui import QPixmap, QImage, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
    QProgressBar,
    QApplication,
)

from app.core.filters import is_quality
from app.core.grade import grade_candidate, grade_label_zh, session_summary, CandidateGrade
from app.core.models import CaptureSession, MediaCandidate, MediaType
from app.core.scoring import sort_candidates

# Cache files (Discord Cache_Data, etc.) often have no extension — still images by magic.
_IMAGE_SUFFIX = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".jfif", ".tif", ".tiff"}


def _pixmap_from_local(
    path: str | Path,
    *,
    max_w: int = 160,
    max_h: int = 120,
    max_bytes: int = 12 * 1024 * 1024,
) -> QPixmap | None:
    """Load a thumbnail for a local image, including extensionless cache blobs."""
    p = Path(path)
    try:
        if not p.is_file():
            return None
        size = p.stat().st_size
        if size <= 32 or size > max_bytes:
            return None
    except OSError:
        return None

    # Fast path: Qt decoders when extension is known
    suf = p.suffix.lower()
    if suf in _IMAGE_SUFFIX:
        pix = QPixmap(str(p))
        if not pix.isNull():
            return pix.scaled(
                max_w,
                max_h,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )

    # Extensionless / exotic: PIL (Discord f_*, webp without plugin, etc.)
    try:
        from PIL import Image

        with Image.open(p) as im:
            im = im.convert("RGBA")
            im.thumbnail((max(max_w, 1), max(max_h, 1)), Image.Resampling.LANCZOS)
            w, h = im.size
            data = im.tobytes("raw", "RGBA")
            qimg = QImage(data, w, h, QImage.Format.Format_RGBA8888)
            # copy — buffer is freed when we leave with-block
            pix = QPixmap.fromImage(qimg.copy())
            if not pix.isNull():
                return pix
    except Exception:
        pass

    # Last resort: Qt without caring about suffix (sometimes works for PNG/JPEG blobs)
    if suf not in _IMAGE_SUFFIX:
        pix = QPixmap(str(p))
        if not pix.isNull():
            return pix.scaled(
                max_w,
                max_h,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
    return None


def _quick_grade(cand: MediaCandidate) -> CandidateGrade:
    """Grade for UI cards without re-scanning large video files on the UI thread."""
    raw = cand.meta.get("grade")
    if raw:
        try:
            return CandidateGrade(raw)
        except Exception:
            pass
    if cand.meta.get("media_complete") is False:
        return CandidateGrade.FRAGMENT
    if cand.source_kind.value == "screenshot" if hasattr(cand.source_kind, "value") else False:
        return CandidateGrade.SCREENSHOT
    from app.core.models import SourceKind

    if cand.source_kind == SourceKind.SCREENSHOT:
        return CandidateGrade.SCREENSHOT
    if cand.local_path and Path(cand.local_path).is_file():
        return CandidateGrade.ORIGINAL
    if (cand.source_url or "").startswith("http"):
        return CandidateGrade.LINK
    return CandidateGrade.OTHER


class _Card(QFrame):
    toggled = Signal(str, bool)
    focused = Signal(str)

    def __init__(self, cand: MediaCandidate, parent=None):
        super().__init__(parent)
        self.cand = cand
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setFixedSize(150, 170)
        self.setStyleSheet(
            """
            _Card { background: #2b2b2b; border-radius: 8px; border: 1px solid #444; }
            _Card[selected="true"] { border: 2px solid #0078d7; }
            _Card[dimmed="true"] { opacity: 0.5; }
            """
        )
        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)
        self.chk = QCheckBox()
        self.chk.setChecked(cand.selected)
        self.chk.toggled.connect(lambda v: self.toggled.emit(cand.id, v))
        top = QHBoxLayout()
        top.addWidget(self.chk)
        g = _quick_grade(cand)
        g_lab = grade_label_zh(g)
        g_colors = {
            CandidateGrade.ORIGINAL: "#3dd68c",
            CandidateGrade.FRAGMENT: "#ff6b6b",
            CandidateGrade.LINK: "#7ec8ff",
            CandidateGrade.SCREENSHOT: "#e0b060",
            CandidateGrade.OTHER: "#aaa",
        }
        grade_badge = QLabel(g_lab)
        grade_badge.setStyleSheet(
            f"color:{g_colors.get(g, '#aaa')};font-size:10px;font-weight:600;"
        )
        badge = QLabel(
            (cand.media_type.value if isinstance(cand.media_type, MediaType) else str(cand.media_type))[:6]
        )
        badge.setStyleSheet("color:#aaa;font-size:10px;")
        top.addStretch()
        top.addWidget(grade_badge)
        top.addWidget(badge)
        lay.addLayout(top)
        self.thumb = QLabel()
        self.thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumb.setFixedHeight(100)
        self.thumb.setStyleSheet("background:#1a1a1a;border-radius:4px;")
        self._load_thumb()
        lay.addWidget(self.thumb)
        meta = QLabel(self._meta_text())
        meta.setStyleSheet("color:#ccc;font-size:10px;")
        meta.setWordWrap(True)
        lay.addWidget(meta)
        if cand.filtered_out:
            self.setProperty("dimmed", "true")
            self.setToolTip(cand.filter_reason or "已过滤")
        self.mousePressEvent = self._on_click  # type: ignore

    def _meta_text(self) -> str:
        parts = []
        if self.cand.width and self.cand.height:
            parts.append(f"{self.cand.width}×{self.cand.height}")
        if self.cand.bytes_hint:
            parts.append(_fmt_bytes(self.cand.bytes_hint))
        if self.cand.extension_id:
            parts.append(self.cand.extension_id.split(".")[-1][:8])
        return " · ".join(parts) or self.cand.display_name()[:20]

    def _load_thumb(self) -> None:
        """Load card thumb; supports extensionless CDN/cache files via PIL.

        Never run ffmpeg here — that freezes the grid.
        """
        mt = self.cand.media_type
        is_vid = mt == MediaType.VIDEO or (isinstance(mt, str) and mt == "video")
        if not is_vid:
            for path in (self.cand.thumb_path, self.cand.local_path):
                if not path:
                    continue
                pix = _pixmap_from_local(path, max_w=140, max_h=100)
                if pix is not None and not pix.isNull():
                    self.thumb.setPixmap(pix)
                    self.thumb.setStyleSheet("background:#1a1a1a;border-radius:4px;")
                    return
            # Link-only image: no local yet
            url = self.cand.source_url or ""
            if url.startswith("http"):
                self.thumb.setText("🔗 链接")
                self.thumb.setStyleSheet(
                    "background:#1a1a1a;color:#7ec8ff;font-size:12px;border-radius:4px;"
                )
                return
            self.thumb.setText(mt.value if isinstance(mt, MediaType) else str(mt or "?"))
            return
        # Video: prefer precomputed thumb_path; no ffmpeg on UI thread
        if self.cand.thumb_path:
            pix = _pixmap_from_local(self.cand.thumb_path, max_w=140, max_h=100)
            if pix is not None and not pix.isNull():
                self.thumb.setPixmap(pix)
                return
        self.thumb.setText("▶ 视频")
        self.thumb.setStyleSheet(
            "background:#1a1a1a;color:#7ec8ff;font-size:14px;border-radius:4px;"
        )

    def _on_click(self, event) -> None:
        self.focused.emit(self.cand.id)
        if event.button() == Qt.MouseButton.LeftButton and not self.chk.geometry().contains(event.pos()):
            # toggle on body click optional — only focus
            pass

    def set_checked(self, v: bool) -> None:
        self.chk.blockSignals(True)
        self.chk.setChecked(v)
        self.chk.blockSignals(False)
        self.cand.selected = v


class MediaGridPanel(QWidget):
    ingest_requested = Signal(list, bool, bool, list)  # cands, restricted, jasna, extra_tags
    download_requested = Signal(list)  # cands to materialize
    status_message = Signal(str)  # toast-friendly status from grid actions
    refresh_requested = Signal()
    screenshot_requested = Signal()
    closed = Signal()

    def __init__(self):
        super().__init__(None, Qt.WindowType.Window)
        self.setWindowTitle("抓取 · 候选")
        self.resize(1180, 720)
        # Full control styles: bare `background/color` alone kills native hover on Windows
        self.setStyleSheet(
            """
            MediaGridPanel, QWidget {
                background: #1e1e1e;
                color: #eee;
            }
            QLabel { color: #eee; background: transparent; }
            QLineEdit, QComboBox {
                background: #2a2a2a;
                color: #eee;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 4px 8px;
                min-height: 22px;
            }
            QLineEdit:focus, QComboBox:focus {
                border: 1px solid #0078d7;
            }
            QComboBox QAbstractItemView {
                background: #2a2a2a;
                color: #eee;
                selection-background-color: #0078d7;
            }
            QCheckBox { color: #ddd; spacing: 6px; }
            QCheckBox::indicator {
                width: 16px; height: 16px;
                border: 1px solid #666;
                border-radius: 3px;
                background: #2a2a2a;
            }
            QCheckBox::indicator:checked {
                background: #0078d7;
                border-color: #0078d7;
            }
            QPushButton {
                background: #3a3a3a;
                color: #f0f0f0;
                border: 1px solid #5a5a5a;
                border-radius: 6px;
                padding: 7px 14px;
                min-height: 28px;
            }
            QPushButton:hover {
                background: #4a90d9;
                border: 1px solid #6ab0ff;
                color: #ffffff;
            }
            QPushButton:pressed {
                background: #2a6cb0;
                border: 1px solid #1a5a9a;
            }
            QPushButton:disabled {
                background: #2a2a2a;
                color: #666;
                border: 1px solid #3a3a3a;
            }
            QPushButton#btnIngest {
                background: #0078d7;
                border: 1px solid #1090f0;
                color: white;
                font-weight: 600;
                padding: 8px 16px;
            }
            QPushButton#btnIngest:hover {
                background: #1a8cf0;
                border: 1px solid #3aa0ff;
            }
            QPushButton#btnIngest:pressed {
                background: #0060b0;
            }
            QProgressBar {
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 4px;
                text-align: center;
                color: #eee;
                min-height: 16px;
            }
            QProgressBar::chunk {
                background: #0078d7;
                border-radius: 3px;
            }
            QScrollArea { border: none; background: #1a1a1a; }
            QSplitter::handle {
                background: #444;
                width: 4px;
            }
            QSplitter::handle:hover { background: #0078d7; }
            """
        )
        self._session: CaptureSession | None = None
        self._cards: dict[str, _Card] = {}
        self._current_id: str | None = None
        self._type_filter = "all"
        self._sort = "recommend"
        self._show_filtered = False
        self._play_path: str | None = None  # resolved playable path for current focus
        self._busy_download = False

        root = QVBoxLayout(self)
        self.header = QLabel("选几张要收进库的，点右下角入库")
        self.header.setStyleSheet("font-size:14px;font-weight:600;background:transparent;")
        root.addWidget(self.header)
        self.sub = QLabel("")
        self.sub.setStyleSheet("color:#aaa;font-size:12px;background:transparent;")
        root.addWidget(self.sub)

        tools = QHBoxLayout()
        for text, slot in [
            ("全选优质", self.select_quality),
            ("全选", self.select_all),
            ("反选", self.invert),
            ("全不选", self.select_none),
        ]:
            b = QPushButton(text)
            b.setCursor(Qt.CursorShape.PointingHandCursor)
            b.clicked.connect(slot)
            tools.addWidget(b)
        self.type_box = QComboBox()
        self.type_box.addItems(["全部", "图", "动图", "视频", "音频"])
        self.type_box.currentIndexChanged.connect(self._on_type)
        tools.addWidget(QLabel("类型"))
        tools.addWidget(self.type_box)
        self.sort_box = QComboBox()
        self.sort_box.addItems(["推荐", "最大", "最新"])
        self.sort_box.currentIndexChanged.connect(self._on_sort)
        tools.addWidget(QLabel("排序"))
        tools.addWidget(self.sort_box)
        self.search = QLineEdit()
        self.search.setPlaceholderText("搜索 URL / 标题…")
        self.search.textChanged.connect(self.rebuild_grid)
        tools.addWidget(self.search, 1)
        self.chk_show_filtered = QCheckBox("显示已过滤")
        self.chk_show_filtered.toggled.connect(self._toggle_filtered)
        tools.addWidget(self.chk_show_filtered)
        root.addLayout(tools)

        self.split = QSplitter(Qt.Orientation.Horizontal)
        # grid (left — wider by default)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setMinimumWidth(520)
        self.grid_host = QWidget()
        self.grid_layout = QGridLayout(self.grid_host)
        self.grid_layout.setSpacing(8)
        self.scroll.setWidget(self.grid_host)
        self.split.addWidget(self.scroll)

        # preview (right)
        prev = QVBoxLayout()
        prev_w = QWidget()
        prev_w.setLayout(prev)
        prev_w.setMinimumWidth(280)
        self.preview_stack = QStackedWidget()
        self.preview_stack.setMinimumSize(260, 220)
        self.preview_stack.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        self.preview = QLabel("预览")
        self.preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview.setStyleSheet("background:#111;border-radius:8px;color:#aaa;")
        self.preview_stack.addWidget(self.preview)
        prev.addWidget(self.preview_stack, 1)

        vctrl = QHBoxLayout()
        self.btn_play = QPushButton("播放（系统播放器）")
        self.btn_play.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_play.setToolTip("用系统默认播放器打开本地文件")
        self.btn_play.clicked.connect(self._open_external)
        self.btn_play.setEnabled(False)
        self.btn_open_ext = QPushButton("打开所在文件夹")
        self.btn_open_ext.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_open_ext.setToolTip("在资源管理器中定位该文件")
        self.btn_open_ext.clicked.connect(self._reveal_in_explorer)
        self.btn_open_ext.setEnabled(False)
        vctrl.addWidget(self.btn_play)
        vctrl.addWidget(self.btn_open_ext)
        prev.addLayout(vctrl)

        self.preview_meta = QLabel("")
        self.preview_meta.setWordWrap(True)
        self.preview_meta.setStyleSheet("color:#ccc;font-size:12px;background:transparent;")
        prev.addWidget(self.preview_meta)
        btn_row = QHBoxLayout()
        self.btn_copy = QPushButton("复制链接")
        self.btn_copy.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_copy.clicked.connect(self.copy_url)
        btn_row.addWidget(self.btn_copy)
        prev.addLayout(btn_row)
        self.split.addWidget(prev_w)
        # Left grid gets more space (≈65% : 35%)
        self.split.setStretchFactor(0, 65)
        self.split.setStretchFactor(1, 35)
        self.split.setSizes([760, 400])
        root.addWidget(self.split, 1)

        # footer
        foot = QHBoxLayout()
        self.sel_label = QLabel("已选 0")
        foot.addWidget(self.sel_label)
        self.chk_restricted = QCheckBox("限制级")
        self.chk_jasna = QCheckBox("jasna")
        foot.addWidget(self.chk_restricted)
        foot.addWidget(self.chk_jasna)
        self.extra_tags = QLineEdit()
        self.extra_tags.setPlaceholderText("附加标签，逗号分隔")
        foot.addWidget(self.extra_tags, 1)
        self.btn_shot = QPushButton("截取窗口补一张")
        self.btn_shot.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_shot.clicked.connect(self.screenshot_requested.emit)
        self.btn_download = QPushButton("下载选中链接")
        self.btn_download.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_download.setToolTip("把「链接」类候选下到本地，便于预览与上传")
        self.btn_download.clicked.connect(self._do_download)
        self.btn_refresh = QPushButton("刷新候选")
        self.btn_refresh.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh.clicked.connect(self.refresh_requested.emit)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_cancel.clicked.connect(self.close)
        self.btn_ingest = QPushButton("入库选中")
        self.btn_ingest.setObjectName("btnIngest")
        self.btn_ingest.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ingest.clicked.connect(self._do_ingest)
        foot.addWidget(self.btn_shot)
        foot.addWidget(self.btn_download)
        foot.addWidget(self.btn_refresh)
        foot.addWidget(self.btn_cancel)
        foot.addWidget(self.btn_ingest)
        root.addLayout(foot)

        self.progress = QProgressBar()
        self.progress.setVisible(False)
        self.progress_label = QLabel("")
        self.progress_label.setStyleSheet("color:#aaa;font-size:11px;")
        self.progress_label.setVisible(False)
        root.addWidget(self.progress_label)
        root.addWidget(self.progress)

        QShortcut(QKeySequence(Qt.Key.Key_Escape), self, self.close)
        QShortcut(QKeySequence(Qt.Key.Key_Space), self, self._toggle_current)
        QShortcut(QKeySequence(Qt.Key.Key_Return), self, self._do_ingest)
        QShortcut(QKeySequence(Qt.Key.Key_Enter), self, self._do_ingest)
        QShortcut(QKeySequence(Qt.Key.Key_Left), self, lambda: self._nav(-1))
        QShortcut(QKeySequence(Qt.Key.Key_Right), self, lambda: self._nav(1))

    def clear_session(self) -> None:
        """Drop previous capture UI so switching apps never shows stale candidates."""
        self._session = None
        self._current_id = None
        try:
            self.header.setText("无会话")
            self.sub.setText("")
            self.setWindowTitle("抓取")
        except Exception:
            pass
        try:
            while self.grid_layout.count():
                item = self.grid_layout.takeAt(0)
                w = item.widget()
                if w is not None:
                    w.deleteLater()
        except Exception:
            pass
        if self.isVisible():
            self.hide()

    def open_session(self, session: CaptureSession, *, restricted: bool = False, use_jasna: bool = False) -> None:
        self._session = session
        self.chk_restricted.setChecked(restricted)
        self.chk_jasna.setChecked(use_jasna)
        n = len(session.candidates)
        self.setWindowTitle(f"抓取 · {session.process_name or '窗口'} · {n} 项")
        sm = session_summary(session.candidates)
        self.header.setText(sm.get("headline") or "选要入库的项，点右下角入库")
        exts = ", ".join(session.extension_ids) if session.extension_ids else "通用"
        tips = []
        if sm.get("link"):
            tips.append("链接可先「下载选中」再预览")
        if sm.get("screenshot") and not sm.get("original"):
            tips.append("仅截图时可用复制链接/另存后再抓")
        tip = (" · " + "；".join(tips)) if tips else ""
        self.sub.setText(f"来源: {session.process_name}  |  扩展: {exts}{tip}")
        # Default: nothing selected — user picks explicitly
        for c in session.candidates:
            c.selected = False
        self.rebuild_grid()
        # Ensure left grid stays wide after open
        if hasattr(self, "split"):
            QTimer.singleShot(0, lambda: self.split.setSizes([760, 400]))
        self.show()
        self.raise_()
        self.activateWindow()

    def append_candidate(self, cand: MediaCandidate) -> None:
        if not self._session:
            return
        self._session.candidates.append(cand)
        if not cand.filtered_out:
            cand.selected = True
        self.rebuild_grid()

    def rebuild_grid(self, *, skip_focus: bool = False) -> None:
        if not self._session:
            return
        if skip_focus:
            self._skip_focus_once = True
        # clear
        while self.grid_layout.count():
            item = self.grid_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        self._cards.clear()

        cands = list(self._session.candidates)
        mode = {0: "recommend", 1: "largest", 2: "newest"}[self.sort_box.currentIndex()]
        cands = sort_candidates(cands, mode)
        q = self.search.text().strip().lower()
        type_map = {0: "all", 1: "image", 2: "gif", 3: "video", 4: "audio"}
        tf = type_map[self.type_box.currentIndex()]

        visible = []
        for c in cands:
            if c.filtered_out and not self._show_filtered:
                continue
            mt = c.media_type.value if isinstance(c.media_type, MediaType) else str(c.media_type)
            if tf != "all" and mt != tf:
                continue
            if q:
                blob = f"{c.title} {c.source_url} {c.extension_id or ''}".lower()
                if q not in blob:
                    continue
            visible.append(c)

        if not visible:
            empty = QLabel("这窗口暂时没有原片\n可用「截取窗口补一张」或「刷新候选」")
            empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            empty.setStyleSheet("color:#888;font-size:14px;padding:40px;")
            self.grid_layout.addWidget(empty, 0, 0)
        else:
            cols = max(1, self.scroll.viewport().width() // 160)
            for i, c in enumerate(visible):
                card = _Card(c)
                card.toggled.connect(self._on_card_toggle)
                card.focused.connect(self._focus)
                self._cards[c.id] = card
                self.grid_layout.addWidget(card, i // cols, i % cols)
        self._update_sel_label()
        if getattr(self, "_skip_focus_once", False):
            self._skip_focus_once = False
            return
        if visible and not self._current_id:
            self._focus(visible[0].id)
        elif self._current_id:
            self._focus(self._current_id)

    def _on_card_toggle(self, cid: str, v: bool) -> None:
        if self._session:
            for c in self._session.candidates:
                if c.id == cid:
                    c.selected = v
                    break
        self._update_sel_label()

    def _stop_player(self) -> None:
        self._play_path = None
        self.btn_play.setText("播放（系统播放器）")

    def _is_video(self, cand: MediaCandidate) -> bool:
        mt = cand.media_type
        if mt == MediaType.VIDEO:
            return True
        if isinstance(mt, str) and mt == "video":
            return True
        mime = (cand.mime or "").lower()
        return mime.startswith("video/")

    def _local_path_fast(self, cand: MediaCandidate) -> str | None:
        """Return local path if file exists — no copy, no scan."""
        if cand.local_path and Path(cand.local_path).is_file():
            return str(Path(cand.local_path).resolve())
        return None

    def _show_still_preview(
        self,
        cand: MediaCandidate,
        local: str | None,
        url: str | None,
        *,
        note: str = "",
    ) -> None:
        self.preview_stack.setCurrentIndex(0)
        is_vid = self._is_video(cand)
        if is_vid:
            msg = "▶ 视频\n" + (local or url or cand.display_name())
            msg += "\n\n点「播放（系统播放器）」用系统默认程序打开"
            if note:
                msg += f"\n\n{note}"
            self.preview.setText(msg)
            return
        path = cand.thumb_path or local
        if path:
            pix = _pixmap_from_local(
                path,
                max_w=max(280, self.preview.width() or 280),
                max_h=max(200, self.preview.height() or 200),
                max_bytes=16 * 1024 * 1024,
            )
            if pix is not None and not pix.isNull():
                self.preview.setPixmap(pix)
                return
        if (url or "").startswith("http") and not local:
            self.preview.setText("链接图片\n下载后可预览\n\n" + (url[:80] if url else ""))
            return
        self.preview.setText(cand.display_name())

    def _focus(self, cid: str) -> None:
        self._current_id = cid
        cand = self._find(cid)
        if not cand:
            return

        self._stop_player()
        is_vid = self._is_video(cand)
        raw_local = self._local_path_fast(cand)
        url = cand.source_url if (cand.source_url or "").startswith("http") else None
        self._play_path = raw_local if is_vid else None

        can_open = bool(raw_local or url)
        self.btn_play.setEnabled(can_open)
        self.btn_open_ext.setEnabled(bool(raw_local))
        self.btn_play.setText("播放（系统播放器）")

        self._show_still_preview(cand, raw_local, url)

        g = _quick_grade(cand)
        lines = [
            cand.display_name(),
            f"分级: {grade_label_zh(g)}  ·  类型: {cand.media_type.value if isinstance(cand.media_type, MediaType) else cand.media_type}"
            f"  {cand.width or '?'}×{cand.height or '?'}  {cand.mime or ''}  {_fmt_bytes(cand.bytes_hint)}",
            f"来源: {cand.source_kind.value} / {cand.extension_id or '-'}",
            f"文件: {raw_local or '-'}",
            f"URL: {cand.source_url or '-'}",
        ]
        if cand.meta.get("download_error"):
            lines.append(f"下载失败: {cand.meta['download_error']}")
        if cand.filtered_out:
            lines.append(f"过滤: {cand.filter_reason}")
        if g == CandidateGrade.LINK and not raw_local:
            lines.append("提示: 勾选后点「下载选中链接」再播放/入库")
        if is_vid:
            lines.append("提示: 播放与打开文件夹均调用系统 shell，不阻塞本窗口")
        self.preview_meta.setText("\n".join(lines))

    def _open_external(self) -> None:
        """Open with OS default app — never copy files / never call ffmpeg on UI thread."""
        cand = self._find(self._current_id or "")
        if not cand:
            return
        path = self._local_path_fast(cand)
        if path:
            try:
                # startfile returns immediately; do not wrap in CREATE_NO_WINDOW
                if sys.platform == "win32":
                    os.startfile(path)  # noqa: S606
                else:
                    webbrowser.open(Path(path).as_uri())
                self.status_message.emit(f"已打开: {Path(path).name}")
            except Exception as e:
                self.status_message.emit(f"打开失败: {e}")
            return
        if (cand.source_url or "").startswith("http"):
            webbrowser.open(cand.source_url)
            self.status_message.emit("已在浏览器打开链接")
            return
        self.status_message.emit("没有可打开的文件（请先下载）")

    def _reveal_in_explorer(self) -> None:
        """Open Explorer selecting the file (Windows-robust, non-blocking)."""
        cand = self._find(self._current_id or "")
        if not cand:
            self.status_message.emit("请先点选一张左侧卡片")
            return
        path = self._local_path_fast(cand)
        if not path:
            self.status_message.emit("当前项没有本地文件（请先下载）")
            return
        p = Path(path).resolve()
        if not p.is_file():
            self.status_message.emit(f"文件不存在: {p}")
            return
        try:
            if sys.platform == "win32":
                ok = _windows_reveal_file(p)
                if ok:
                    self.status_message.emit(f"已在资源管理器中定位: {p.name}")
                else:
                    # last resort: open parent folder
                    os.startfile(str(p.parent))  # noqa: S606
                    self.status_message.emit(f"已打开文件夹: {p.parent}")
            else:
                subprocess.Popen(["xdg-open", str(p.parent)])
                self.status_message.emit("已打开所在文件夹")
        except Exception as e:
            self.status_message.emit(f"打开文件夹失败: {e}")

    def _find(self, cid: str) -> MediaCandidate | None:
        if not self._session:
            return None
        for c in self._session.candidates:
            if c.id == cid:
                return c
        return None

    def _update_sel_label(self) -> None:
        n = sum(1 for c in (self._session.candidates if self._session else []) if c.selected)
        self.sel_label.setText(f"已选 {n}")
        self.btn_ingest.setText(f"入库选中 {n}" if n else "入库选中")

    def select_quality(self) -> None:
        if not self._session:
            return
        for c in self._session.candidates:
            c.selected = is_quality(c) and not c.filtered_out
        self.rebuild_grid()

    def select_all(self) -> None:
        if not self._session:
            return
        for c in self._session.candidates:
            if not c.filtered_out or self._show_filtered:
                c.selected = True
        self.rebuild_grid()

    def select_none(self) -> None:
        if not self._session:
            return
        for c in self._session.candidates:
            c.selected = False
        self.rebuild_grid()

    def invert(self) -> None:
        if not self._session:
            return
        for c in self._session.candidates:
            if not c.filtered_out or self._show_filtered:
                c.selected = not c.selected
        self.rebuild_grid()

    def _on_type(self, _i: int) -> None:
        self.rebuild_grid()

    def _on_sort(self, _i: int) -> None:
        self.rebuild_grid()

    def _toggle_filtered(self, v: bool) -> None:
        self._show_filtered = v
        self.rebuild_grid()

    def _toggle_current(self) -> None:
        if not self._current_id or not self._session:
            return
        for c in self._session.candidates:
            if c.id == self._current_id:
                c.selected = not c.selected
                break
        self.rebuild_grid()

    def _nav(self, delta: int) -> None:
        ids = list(self._cards.keys())
        if not ids:
            return
        if self._current_id not in ids:
            self._focus(ids[0])
            return
        i = ids.index(self._current_id)
        self._focus(ids[(i + delta) % len(ids)])

    def copy_url(self) -> None:
        cand = self._find(self._current_id or "")
        if cand and cand.source_url:
            QApplication.clipboard().setText(cand.source_url)

    def _do_ingest(self) -> None:
        if not self._session:
            return
        selected = [c for c in self._session.candidates if c.selected]
        if not selected and self._current_id:
            cur = self._find(self._current_id)
            if cur:
                selected = [cur]
        if not selected:
            self.status_message.emit("请先勾选要入库的项（或点选一张卡片）")
            return
        tags = [t.strip() for t in self.extra_tags.text().split(",") if t.strip()]
        self.ingest_requested.emit(selected, self.chk_restricted.isChecked(), self.chk_jasna.isChecked(), tags)

    def _do_download(self) -> None:
        if not self._session:
            return
        if self._busy_download:
            self.status_message.emit("正在下载，请稍候…")
            return

        def needs_http_dl(c: MediaCandidate) -> bool:
            if not (c.source_url or "").startswith("http"):
                return False
            if c.local_path and Path(c.local_path).is_file():
                return False
            return True

        selected = [c for c in self._session.candidates if c.selected and needs_http_dl(c)]
        if not selected:
            selected = [
                c
                for c in self._session.candidates
                if c.selected and (c.source_url or "").startswith("http")
            ]
        # fallback: current focused card
        if not selected and self._current_id:
            cur = self._find(self._current_id)
            if cur and (cur.source_url or "").startswith("http"):
                selected = [cur]
            elif cur and cur.local_path and Path(cur.local_path).is_file():
                g = grade_candidate(cur)
                if g == CandidateGrade.FRAGMENT or cur.meta.get("media_complete") is False:
                    self.status_message.emit(
                        "这是 Discord 缓存残片（不完整），无法下载修复。\n"
                        "请：右键视频→复制链接→再点抓取；或另存到「下载」文件夹后抓取。"
                    )
                else:
                    self.status_message.emit(
                        f"「{cur.display_name()[:32]}」已是本地完整文件，无需下载；可直接入库"
                    )
                return

        if not selected:
            n_sel = sum(1 for c in self._session.candidates if c.selected)
            frags = sum(
                1
                for c in self._session.candidates
                if c.selected and grade_candidate(c) == CandidateGrade.FRAGMENT
            )
            if n_sel == 0:
                self.status_message.emit(
                    "请先勾选「链接」类候选（蓝标），或复制 Discord 视频链接后再抓取"
                )
            elif frags:
                self.status_message.emit(
                    "选中的是缓存残片，不能当完整视频下载/入库。\n"
                    "请复制视频链接后重新抓取，或另存为到「下载」。"
                )
            else:
                self.status_message.emit(
                    f"已选 {n_sel} 项均为本地文件/截图，没有可下载的 http 链接"
                )
            return
        self.status_message.emit(f"开始下载 {len(selected)} 个链接…")
        self.set_progress(0, 1000, label=f"准备下载 {len(selected)} 项…", auto_hide=False)
        self.download_requested.emit(selected)

    def soft_update_candidate(self, cand: MediaCandidate) -> None:
        """Update header/meta without rebuild or focus (safe during download)."""
        if not self._session:
            return
        try:
            self.header.setText(
                session_summary(self._session.candidates).get("headline") or self.header.text()
            )
        except Exception:
            pass
        if self._current_id == cand.id:
            # refresh meta text only
            g = grade_candidate(cand)
            local = cand.local_path if cand.local_path and Path(cand.local_path).is_file() else None
            extra = f"\n已下载: {local}" if local else ""
            if cand.meta.get("download_error"):
                extra += f"\n下载失败: {cand.meta['download_error']}"
            base = self.preview_meta.text().split("\n已下载:")[0].split("\n下载失败:")[0]
            self.preview_meta.setText(base + extra)
            self.btn_play.setEnabled(bool(local or (cand.source_url or "").startswith("http")))

    def refresh_candidate(self, cand: MediaCandidate) -> None:
        """Light refresh — avoid full grid rebuild + focus (was freezing UI)."""
        self.soft_update_candidate(cand)

    def set_progress(
        self,
        cur: int,
        total: int,
        label: str = "",
        *,
        auto_hide: bool = True,
    ) -> None:
        self.progress.setVisible(True)
        self.progress.setMaximum(max(total, 1))
        self.progress.setValue(min(max(cur, 0), max(total, 1)))
        if label:
            self.progress_label.setText(label)
            self.progress_label.setVisible(True)
        if auto_hide and cur >= total and total > 0:
            # delay hide so user sees 100%
            QTimer.singleShot(
                800,
                lambda: (
                    self.progress.setVisible(False),
                    self.progress_label.setVisible(False),
                    self.progress_label.setText(""),
                ),
            )

    def closeEvent(self, event) -> None:  # noqa: N802
        self._stop_player()
        self.closed.emit()
        super().closeEvent(event)


def _fmt_bytes(n: int | None) -> str:
    if not n:
        return ""
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n/1024:.1f}KB"
    return f"{n/1024/1024:.1f}MB"


def _windows_reveal_file(path: Path) -> bool:
    """
    Show file in Explorer. Prefer ShellExecute; avoid shell=True + CREATE_NO_WINDOW.
    Returns True if an open method was launched without exception.
    """
    path = Path(path).resolve()
    # 1) ShellExecuteW explorer /select,"fullpath"
    try:
        from ctypes import windll

        # SW_SHOWNORMAL = 1
        rc = windll.shell32.ShellExecuteW(
            None,
            "open",
            "explorer.exe",
            f'/select,"{path}"',
            None,
            1,
        )
        # >32 means success for ShellExecute
        if int(rc) > 32:
            return True
    except Exception:
        pass
    # 2) list-form Popen without CREATE_NO_WINDOW
    try:
        # /select, must be glued to path per explorer syntax
        subprocess.Popen(
            ["explorer.exe", f"/select,{path}"],
            close_fds=True,
        )
        return True
    except Exception:
        pass
    # 3) open parent directory only
    try:
        os.startfile(str(path.parent))  # noqa: S606
        return True
    except Exception:
        return False
