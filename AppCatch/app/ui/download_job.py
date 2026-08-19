"""Background download job with polled progress (avoids Qt cross-thread signal starvation)."""

from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class DownloadProgress:
    value: int = 0  # 0..1000
    maximum: int = 1000
    label: str = ""
    done: bool = False
    ok: int = 0
    fail: int = 0
    error: str = ""


class DownloadJob:
    """
    Runs materialize for a list of candidates on a plain threading.Thread.
    UI polls `snapshot()` every ~100ms — more reliable than Signal flood under GIL load.
    """

    def __init__(
        self,
        materialize_fn: Callable[..., tuple[bool, str]],
        cands: list[Any],
    ):
        self._materialize = materialize_fn
        self._cands = list(cands)
        self._lock = threading.Lock()
        self._prog = DownloadProgress()
        self._thread: threading.Thread | None = None
        self._cancel = False

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="AppCatch-Download", daemon=True)
        self._thread.start()

    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def snapshot(self) -> DownloadProgress:
        with self._lock:
            p = self._prog
            return DownloadProgress(
                value=p.value,
                maximum=p.maximum,
                label=p.label,
                done=p.done,
                ok=p.ok,
                fail=p.fail,
                error=p.error,
            )

    def _set(self, **kwargs: Any) -> None:
        with self._lock:
            for k, v in kwargs.items():
                setattr(self._prog, k, v)

    def _run(self) -> None:
        ok = fail = 0
        n = max(len(self._cands), 1)
        scale = 1000
        try:
            for i, c in enumerate(self._cands):
                if self._cancel:
                    break
                title = ""
                try:
                    title = (c.title or c.display_name() or "")[:40]
                except Exception:
                    title = str(getattr(c, "id", i))
                base = int(scale * i / n)
                span = max(int(scale / n), 1)
                self._set(value=base, maximum=scale, label=f"[{i + 1}/{n}] 开始 · {title}")

                last_ui = [0.0]

                def on_bytes(
                    done: int,
                    total: int | None,
                    phase: str,
                    _base=base,
                    _span=span,
                    _i=i,
                    _title=title,
                ) -> None:
                    import time as _t

                    now = _t.monotonic()
                    # at least ~8 updates/sec, always allow 0% and 100%
                    if total and total > 0:
                        frac = min(1.0, max(0.0, done / float(total)))
                    else:
                        frac = min(0.92, done / float(done + 8 * 1024 * 1024))
                    # throttle label spam but keep bar moving every 120ms
                    if frac < 0.999 and (now - last_ui[0]) < 0.12:
                        return
                    last_ui[0] = now
                    val = _base + int(_span * frac)
                    if total and total > 0:
                        label = (
                            f"[{_i + 1}/{n}] {phase} "
                            f"{done / (1024 * 1024):.1f}/{total / (1024 * 1024):.1f} MB · {_title}"
                        )
                    else:
                        label = (
                            f"[{_i + 1}/{n}] {phase} "
                            f"{done / (1024 * 1024):.1f} MB · {_title}"
                        )
                    self._set(value=val, maximum=scale, label=label)

                try:
                    success, msg = self._materialize(c, progress_cb=on_bytes)
                except Exception as e:
                    success, msg = False, str(e)
                    traceback.print_exc()
                if success:
                    ok += 1
                    try:
                        c.meta["media_complete"] = True
                        c.meta["grade"] = "original"
                    except Exception:
                        pass
                else:
                    fail += 1
                    try:
                        c.meta["download_error"] = msg
                    except Exception:
                        pass
                self._set(
                    value=base + span,
                    maximum=scale,
                    label=f"[{i + 1}/{n}] {'成功' if success else '失败'} · {title}",
                    ok=ok,
                    fail=fail,
                )
            self._set(
                value=scale,
                maximum=scale,
                label=f"完成：成功 {ok} · 失败 {fail}",
                done=True,
                ok=ok,
                fail=fail,
            )
        except Exception as e:
            traceback.print_exc()
            self._set(
                value=scale,
                maximum=scale,
                label=f"下载异常: {e}",
                done=True,
                ok=ok,
                fail=fail,
                error=str(e),
            )
