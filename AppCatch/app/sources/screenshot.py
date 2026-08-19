from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from PIL import Image

from app.core.config import ROOT
from app.core.models import MediaCandidate, MediaType, SourceKind, WindowInfo


def _temp_dir() -> Path:
    d = ROOT / "data" / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def capture_window(info: WindowInfo) -> MediaCandidate:
    """Capture window client/outer area via BitBlt / PrintWindow."""
    if sys.platform != "win32":
        raise RuntimeError("screenshot only on Windows")

    import win32gui
    import win32ui
    import win32con

    hwnd = info.hwnd
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    w = max(1, right - left)
    h = max(1, bottom - top)

    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(mfc_dc, w, h)
    save_dc.SelectObject(bitmap)

    # PrintWindow works better for some layered/DWM windows (PW_RENDERFULLCONTENT=2)
    PW_RENDERFULLCONTENT = 2
    result = windll_print_window(hwnd, save_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
    if result != 1:
        save_dc.BitBlt((0, 0), (w, h), mfc_dc, (0, 0), win32con.SRCCOPY)

    bmpinfo = bitmap.GetInfo()
    bmpstr = bitmap.GetBitmapBits(True)
    img = Image.frombuffer(
        "RGB",
        (bmpinfo["bmWidth"], bmpinfo["bmHeight"]),
        bmpstr,
        "raw",
        "BGRX",
        0,
        1,
    )

    win32gui.DeleteObject(bitmap.GetHandle())
    save_dc.DeleteDC()
    mfc_dc.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwnd_dc)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    proc = (info.process_name or "window").replace(".exe", "")
    out = _temp_dir() / f"shot_{proc}_{ts}.png"
    img.save(out, "PNG")
    size = out.stat().st_size

    return MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.SCREENSHOT,
        extension_id="builtin.screenshot",
        process_name=info.process_name,
        pid=info.pid,
        title=f"{proc} 截图 {ts}",
        source_url=f"appcatch://screenshot/{proc}/{ts}",
        local_path=str(out),
        bytes_hint=size,
        width=img.width,
        height=img.height,
        mime="image/png",
        thumb_path=str(out),
        score=0.3,
    )


def windll_print_window(hwnd, hdc, flags: int) -> int:
    from ctypes import windll

    return int(windll.user32.PrintWindow(hwnd, hdc, flags))
