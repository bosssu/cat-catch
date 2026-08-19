"""Extension plugin runtime: context, safe hooks, L-B collectors."""

from __future__ import annotations

import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypeVar

from app.core.config import AppConfig
from app.core.models import CaptureSession, MediaCandidate

T = TypeVar("T")

# Shared pool so we do not spawn a thread per call unbounded
_EXEC = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ext_hook")


@dataclass
class ExtensionContext:
    """Passed into plugin hooks (collect / on_network_item / before_ingest)."""

    cfg: AppConfig
    ext: Any  # ExtensionInfo
    _emit: list[MediaCandidate] = field(default_factory=list)

    def log(self, msg: str) -> None:
        eid = getattr(self.ext, "id", "?")
        print(f"[{eid}] {msg}")

    def get_temp_dir(self) -> Path:
        eid = getattr(self.ext, "id", "unknown")
        d = self.cfg.root / "data" / "tmp" / str(eid)
        d.mkdir(parents=True, exist_ok=True)
        return d

    def emit(self, candidate: MediaCandidate) -> None:
        """Accumulate a candidate during a hook (optional alternative to return list)."""
        if candidate is not None:
            self._emit.append(candidate)

    def take_emitted(self) -> list[MediaCandidate]:
        out = list(self._emit)
        self._emit.clear()
        return out


def safe_call(fn: Callable[..., T], *args: Any, timeout_sec: float = 5, default: T | None = None, ext: Any = None) -> T | None:
    """
    Run a plugin hook; on exception or timeout record ext.error and return default.
    """
    try:
        fut = _EXEC.submit(fn, *args)
        return fut.result(timeout=timeout_sec)
    except FuturesTimeout:
        msg = f"hook timeout after {timeout_sec}s"
        if ext is not None:
            ext.error = msg
        return default
    except Exception as e:
        if ext is not None:
            ext.error = str(e)
        traceback.print_exc()
        return default


def _stamp(cands: list[MediaCandidate] | None, ext_id: str) -> list[MediaCandidate]:
    out: list[MediaCandidate] = []
    for c in cands or []:
        if c is None:
            continue
        if not c.extension_id:
            c.extension_id = ext_id
        out.append(c)
    return out


def run_collect(ext: Any, session: CaptureSession, cfg: AppConfig) -> list[MediaCandidate]:
    """Call plugin.collect_candidates if present."""
    plugin = getattr(ext, "plugin", None)
    if not plugin or not hasattr(plugin, "collect_candidates"):
        return []
    ctx = ExtensionContext(cfg=cfg, ext=ext)
    got = safe_call(plugin.collect_candidates, ctx, session, timeout_sec=5, default=None, ext=ext)
    emitted = ctx.take_emitted()
    if got is None and not emitted:
        return []
    merged = list(got or []) + emitted
    if isinstance(session, CaptureSession) and getattr(ext, "error", ""):
        session.errors.append(f"{ext.id}: {ext.error}")
    return _stamp(merged, ext.id)


def run_on_network_item(
    ext: Any,
    session: CaptureSession | None,
    raw_dict: dict[str, Any],
    cfg: AppConfig,
) -> list[MediaCandidate]:
    """Call plugin.on_network_item if present."""
    plugin = getattr(ext, "plugin", None)
    if not plugin or not hasattr(plugin, "on_network_item"):
        return []
    ctx = ExtensionContext(cfg=cfg, ext=ext)
    got = safe_call(
        plugin.on_network_item,
        ctx,
        session,
        raw_dict,
        timeout_sec=5,
        default=None,
        ext=ext,
    )
    emitted = ctx.take_emitted()
    if got is None and not emitted:
        return []
    merged = list(got or []) + emitted
    if session is not None and getattr(ext, "error", ""):
        session.errors.append(f"{ext.id}: {ext.error}")
    return _stamp(merged, ext.id)


def run_before_ingest(ext: Any, candidate: MediaCandidate, cfg: AppConfig) -> MediaCandidate:
    """Call plugin.before_ingest; returns (possibly modified) candidate. On failure returns original."""
    plugin = getattr(ext, "plugin", None)
    if not plugin or not hasattr(plugin, "before_ingest"):
        return candidate
    ctx = ExtensionContext(cfg=cfg, ext=ext)
    got = safe_call(
        plugin.before_ingest,
        ctx,
        candidate,
        timeout_sec=5,
        default=candidate,
        ext=ext,
    )
    if got is None:
        return candidate
    return got
