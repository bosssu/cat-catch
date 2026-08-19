from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Callable

from app.core.config import ROOT
from app.sources.network_sentry import NetworkSentry

DEFAULT_INBOX = ROOT / "data" / "network_inbox.jsonl"
POLL_INTERVAL_S = 0.5


def inbox_path() -> Path:
    return DEFAULT_INBOX


def ensure_inbox_file(path: Path | None = None) -> Path:
    p = path or DEFAULT_INBOX
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.touch()
    return p


def append_inbox_line(obj: dict[str, Any], path: Path | None = None) -> None:
    """Append one JSON object as a line (for tests / external feeders)."""
    p = ensure_inbox_file(path)
    line = json.dumps(obj, ensure_ascii=False)
    with p.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def parse_inbox_line(line: str) -> dict[str, Any] | None:
    line = (line or "").strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def feed_sentry_from_obj(sentry: NetworkSentry, obj: dict[str, Any]) -> None:
    url = str(obj.get("url") or "").strip()
    if not url:
        return
    pid = obj.get("pid")
    if pid is not None:
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            pid = None
    process_name = str(obj.get("process_name") or "")
    mime = str(obj.get("mime") or "")
    bytes_hint = obj.get("bytes")
    if bytes_hint is None:
        bytes_hint = obj.get("content_length")
    if bytes_hint is not None:
        try:
            bytes_hint = int(bytes_hint)
        except (TypeError, ValueError):
            bytes_hint = None
    headers = obj.get("headers")
    if not isinstance(headers, dict):
        headers = {}
    else:
        headers = {str(k): str(v) for k, v in headers.items()}
    referer = str(obj.get("referer") or headers.get("Referer") or headers.get("referer") or "")
    sentry.observe(
        url,
        pid=pid,
        process_name=process_name,
        mime=mime,
        content_length=bytes_hint,
        headers=headers,
        referer=referer,
    )


class NetworkInboxWatcher:
    """
    Tail `data/network_inbox.jsonl` every 0.5s in a daemon thread;
    each line is JSON fed into NetworkSentry.observe(...).
    """

    def __init__(
        self,
        sentry: NetworkSentry,
        path: Path | None = None,
        poll_interval: float = POLL_INTERVAL_S,
        on_error: Callable[[Exception], None] | None = None,
    ):
        self.sentry = sentry
        self.path = path or DEFAULT_INBOX
        self.poll_interval = float(poll_interval)
        self.on_error = on_error
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._offset = 0
        self._lock = threading.Lock()

    def start(self) -> None:
        ensure_inbox_file(self.path)
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            # start from end so we only see new lines after start
            try:
                self._offset = self.path.stat().st_size
            except OSError:
                self._offset = 0
            self.sentry.start()
            t = threading.Thread(target=self._run, name="NetworkInboxWatcher", daemon=True)
            self._thread = t
            t.start()

    def stop(self) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=2.0)
        self.sentry.stop()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception as e:
                if self.on_error:
                    try:
                        self.on_error(e)
                    except Exception:
                        pass
            self._stop.wait(self.poll_interval)

    def _poll_once(self) -> None:
        p = self.path
        if not p.exists():
            ensure_inbox_file(p)
            self._offset = 0
            return
        try:
            size = p.stat().st_size
        except OSError:
            return
        if size < self._offset:
            # truncated / rotated
            self._offset = 0
        if size == self._offset:
            return
        with p.open("r", encoding="utf-8", errors="replace") as f:
            f.seek(self._offset)
            chunk = f.read()
            self._offset = f.tell()
        for line in chunk.splitlines():
            obj = parse_inbox_line(line)
            if obj:
                feed_sentry_from_obj(self.sentry, obj)

    def poll_once(self) -> None:
        """Public single-shot poll (tests / manual)."""
        self._poll_once()
