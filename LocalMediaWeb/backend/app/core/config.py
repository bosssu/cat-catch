from __future__ import annotations

import os
import shutil
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# LocalMediaWeb/ (repo subfolder)
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _resolve(path: str | Path) -> Path:
    p = Path(path)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    return p.resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LMW_",
        env_file=str(PROJECT_ROOT / ".env"),
        extra="ignore",
    )

    host: str = "0.0.0.0"
    port: int = 8790
    access_token: str = ""

    # Desktop launcher (Windows start.ps1 / start.bat)
    # open browser after health OK
    open_browser: bool = False
    # hide PowerShell/console window (server runs in background)
    hide_console: bool = True
    # when true, install-autostart registers a logon task (script still needed once)
    autostart: bool = True
    # at logon: run uv sync (slower) or skip if deps already installed
    autostart_uv_sync: bool = False

    medias_dir: str = "Medias"
    data_dir: str = "data"

    user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    # 是否读取 HTTP(S)_PROXY / ALL_PROXY 等环境代理。
    # 注意：双击 start.bat 启动时进程未必带有终端里的代理变量。
    http_trust_env: bool = True
    # 显式代理（推荐写在 settings.yaml），例如 http://127.0.0.1:7897
    # 优先级高于环境变量；留空则尝试 env → 直连 → 本地端口探测
    http_proxy: str = ""
    https_proxy: str = ""
    # 探测本机 Clash/v2ray 常见端口 (7897/7890/10809…)
    http_proxy_auto_probe: bool = True
    request_timeout_sec: float = 60.0
    # parallel jobs (separate files downloading at once)
    download_concurrency: int = 4
    # per-file multi-connection Range shards for large direct downloads
    direct_connections: int = 4
    max_file_bytes: int = 0

    # Gopeed CLI (PC large direct files only; m3u8/DASH never use it)
    # Enabled by default; auto no-op if binary missing or file below threshold
    gopeed_enabled: bool = True
    gopeed_path: str = ""  # empty = PATH / common install locations
    gopeed_connections: int = 16
    gopeed_min_bytes: int = 5 * 1024 * 1024  # only try when Content-Length >= this

    hls_concurrency: int = 8
    hls_segment_retries: int = 3
    hls_max_segment_failure_ratio: float = 0.02
    hls_max_missing_segments: int = 5
    hls_partial_strategy: str = "tolerate"  # strict | tolerate | stop
    hls_max_duration_min: int = 180

    profile: str = "pc"

    def medias_path(self) -> Path:
        return _resolve(self.medias_dir)

    def data_path(self) -> Path:
        return _resolve(self.data_dir)

    def thumbs_path(self) -> Path:
        return self.data_path() / "thumbs"

    def tmp_path(self) -> Path:
        return self.data_path() / "tmp"

    def logs_path(self) -> Path:
        return self.data_path() / "logs"

    def db_path(self) -> Path:
        return self.data_path() / "media.db"

    def ensure_dirs(self) -> None:
        self.medias_path().mkdir(parents=True, exist_ok=True)
        (self.medias_path() / "default").mkdir(parents=True, exist_ok=True)
        self.thumbs_path().mkdir(parents=True, exist_ok=True)
        self.tmp_path().mkdir(parents=True, exist_ok=True)
        self.logs_path().mkdir(parents=True, exist_ok=True)

    def apply_profile(self) -> None:
        if self.profile == "router":
            self.download_concurrency = min(self.download_concurrency, 1)
            self.direct_connections = min(self.direct_connections, 2)
            self.hls_concurrency = min(self.hls_concurrency, 3)
            # routers typically have no Gopeed binary; avoid spawn attempts
            self.gopeed_enabled = False


def _load_yaml() -> dict[str, Any]:
    for name in ("settings.yaml", "settings.example.yaml"):
        path = PROJECT_ROOT / "config" / name
        if path.is_file():
            with path.open("r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            if isinstance(data, dict):
                return data
    return {}


@lru_cache
def get_settings() -> Settings:
    data = _load_yaml()
    settings = Settings(**{k: v for k, v in data.items() if v is not None})
    settings.apply_profile()
    settings.ensure_dirs()
    return settings


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def gopeed_binary_available() -> bool:
    """True if gopeed CLI can be resolved (ignores gopeed_enabled flag)."""
    from app.services.gopeed import resolve_gopeed_path

    return resolve_gopeed_path("") is not None
