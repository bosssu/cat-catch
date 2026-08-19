"""Configure process-wide logging so plugin/upload/merge can be tracked on disk.

Hidden uvicorn (start.ps1 / Task Scheduler) has no console; without a file handler,
lmw.* loggers only go to nowhere useful. This writes rotating app.log under data/logs.
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

_CONFIGURED = False


def setup_logging(*, logs_dir: Path | None = None, level: int = logging.INFO) -> Path | None:
    """
    Idempotent. Attach console + rotating file handlers to the ``lmw`` logger tree
    and align uvicorn loggers to the same file when present.
    Returns the log file path, or None if logs_dir could not be created.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return None

    log_path: Path | None = None
    handlers: list[logging.Handler] = []

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console (visible only when not Hidden)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    sh.setLevel(level)
    handlers.append(sh)

    if logs_dir is not None:
        try:
            logs_dir.mkdir(parents=True, exist_ok=True)
            log_path = logs_dir / "app.log"
            fh = RotatingFileHandler(
                log_path,
                maxBytes=8 * 1024 * 1024,
                backupCount=5,
                encoding="utf-8",
            )
            fh.setFormatter(fmt)
            fh.setLevel(level)
            handlers.append(fh)
        except OSError as e:
            # Still allow console-only
            logging.getLogger("lmw").warning("could not open app.log: %s", e)
            log_path = None

    root_lmw = logging.getLogger("lmw")
    root_lmw.handlers.clear()
    root_lmw.setLevel(level)
    root_lmw.propagate = False
    for h in handlers:
        root_lmw.addHandler(h)

    # Child loggers (lmw.download, lmw.media_process, …) propagate to lmw by default
    # when they use getLogger("lmw.xxx") — ensure they don't also dump to root noisily.
    for name in ("lmw.download", "lmw.media_process", "lmw.jasna", "lmw.reencode", "lmw.api"):
        lg = logging.getLogger(name)
        lg.setLevel(level)
        lg.propagate = True

    # Attach file handler only on the top-level ``uvicorn`` logger.
    # Children (uvicorn.error / uvicorn.access) propagate upward — attaching to
    # both parent and child would duplicate every line in app.log.
    if log_path is not None:
        file_handlers = [h for h in handlers if isinstance(h, RotatingFileHandler)]
        ul = logging.getLogger("uvicorn")
        ul.setLevel(logging.INFO)
        for h in file_handlers:
            if h not in ul.handlers:
                ul.addHandler(h)
        for child in ("uvicorn.error", "uvicorn.access"):
            logging.getLogger(child).setLevel(logging.INFO)

    _CONFIGURED = True
    root_lmw.info("logging ready file=%s level=%s", log_path or "(console only)", logging.getLevelName(level))
    return log_path
