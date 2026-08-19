from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yaml"
EXAMPLE_CONFIG = ROOT / "config.example.yaml"


def load_config(path: Path | None = None) -> dict[str, Any]:
    p = path or DEFAULT_CONFIG
    if not p.is_file() and EXAMPLE_CONFIG.is_file():
        p = EXAMPLE_CONFIG
    data: dict[str, Any] = {}
    if p.is_file():
        loaded = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            data = loaded
    lmw = data.get("lmw") if isinstance(data.get("lmw"), dict) else {}
    return {
        "host": str(data.get("host") or "127.0.0.1"),
        "port": int(data.get("port") or 8792),
        "download_dir": str(data.get("download_dir") or "data/downloads"),
        "ios_lock": bool(data.get("ios_lock", True)),
        "max_height": int(data.get("max_height") or 1080),
        "concurrency": max(1, int(data.get("concurrency") or 1)),
        "keep_file": bool(data.get("keep_file", True)),
        "cookies_file": str(data.get("cookies_file") or ""),
        "cookies_from_browser": str(data.get("cookies_from_browser") or "edge"),
        "download_timeout": max(60, int(data.get("download_timeout") or 2400)),
        "stall_timeout": max(30, int(data.get("stall_timeout") or 180)),
        "proxy": str(data.get("proxy") or "http://127.0.0.1:7897"),
        "lmw": {
            "base_url": str(lmw.get("base_url") or "http://192.168.10.84:8790").rstrip("/"),
            "token": str(lmw.get("token") or ""),
            "remux": bool(lmw.get("remux", False)),
            "upload": bool(lmw.get("upload", True)),
            "retries": max(1, int(lmw.get("retries") or 3)),
            "retry_backoff": float(lmw.get("retry_backoff") or 2.0),
        },
    }


def resolve_dir(cfg: dict[str, Any], key: str) -> Path:
    raw = Path(cfg[key])
    if not raw.is_absolute():
        raw = ROOT / raw
    raw.mkdir(parents=True, exist_ok=True)
    return raw
