from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = ROOT / "config.yaml"
EXAMPLE_CONFIG_PATH = ROOT / "config.example.yaml"

_DEFAULTS: dict[str, Any] = {
    "lmw": {"base_url": "http://127.0.0.1:8790", "token": ""},
    "ui": {
        "show_hover_button": True,
        "allow_screenshot_fallback": True,
        # Always open grid for confirmation — never auto-ingest from smart catch
        "one_click_when_single": False,
        "multi_open_grid": "always",
        "hover_dwell_ms": 350,
        "start_with_windows": False,
        "grid_remember_geometry": True,
    },
    "capture": {
        "network_enabled": True,
        "cache_enabled": True,
        "min_edge_px": 200,
        "min_bytes": 10240,
        "skip_avatar_like": True,
        "skip_incomplete_video": True,
        "types": ["image", "gif", "video"],
        "ignore_processes": [
            "AppCatch",
            "explorer",
            "SearchHost",
            "ShellExperienceHost",
            "ApplicationFrameHost",
            "SystemSettings",
            "TextInputHost",
        ],
    },
    "ingest": {
        "default_tags": ["桌面抓取"],
        "auto_tag_app": True,
        "restricted": False,
        "use_jasna": False,
    },
    "extensions": {
        "directory": "extensions",
        "disabled_ids": [],
        "auto_reload_on_focus": False,
    },
    "download": {
        "enabled": True,
        # Prefer direct HTTP for CDN attachments (smooth byte progress); yt-dlp for site pages
        "prefer_ytdlp": True,
        "timeout_sec": 180,
        "max_bytes": 524288000,
    },
    "watch_dirs": [],
}


def _deep_merge(base: dict, overlay: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class AppConfig:
    def __init__(self, data: dict[str, Any], path: Path):
        self.data = data
        self.path = path

    @classmethod
    def load(cls, path: Path | None = None) -> AppConfig:
        path = path or DEFAULT_CONFIG_PATH
        if not path.exists() and EXAMPLE_CONFIG_PATH.exists():
            path.write_text(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        raw: dict[str, Any] = {}
        if path.exists():
            raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls(_deep_merge(_DEFAULTS, raw), path)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            yaml.safe_dump(self.data, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )

    def get(self, *keys: str, default: Any = None) -> Any:
        cur: Any = self.data
        for k in keys:
            if not isinstance(cur, dict) or k not in cur:
                return default
            cur = cur[k]
        return cur

    def set(self, *keys_and_value: Any) -> None:
        *keys, value = keys_and_value
        cur = self.data
        for k in keys[:-1]:
            cur = cur.setdefault(k, {})
        cur[keys[-1]] = value

    @property
    def root(self) -> Path:
        return ROOT

    def extensions_dir(self) -> Path:
        d = self.get("extensions", "directory", default="extensions")
        p = Path(d)
        if not p.is_absolute():
            p = ROOT / p
        return p
