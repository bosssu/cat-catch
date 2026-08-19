from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Any

import httpx

from app.core.config import AppConfig


class LmwClient:
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg

    @property
    def base_url(self) -> str:
        return (self.cfg.get("lmw", "base_url", default="http://127.0.0.1:8790") or "").rstrip("/")

    @property
    def token(self) -> str:
        return self.cfg.get("lmw", "token", default="") or ""

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {}
        if self.token:
            h["X-LMW-Token"] = self.token
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def health(self, timeout: float = 3.0) -> dict[str, Any]:
        with httpx.Client(timeout=timeout) as client:
            r = client.get(f"{self.base_url}/api/health")
            r.raise_for_status()
            return r.json()

    def open_library_url(self) -> str:
        return self.base_url + "/"

    def upload(
        self,
        file_path: str | Path,
        *,
        title: str = "",
        source_url: str = "",
        media_type: str = "",
        tags: list[str] | None = None,
        restricted: bool = False,
        use_jasna: bool = False,
        remux: bool = True,
        timeout: float = 600.0,
    ) -> dict[str, Any]:
        path = Path(file_path)
        if not path.is_file():
            raise FileNotFoundError(str(path))
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = {
            "category": "default",
            "title": title or path.stem,
            "source_url": source_url or "",
            "media_type": media_type or "",
            "remux": "1" if remux else "0",
            "tags": json.dumps(tags or [], ensure_ascii=False),
            "use_jasna": "1" if use_jasna else "0",
            "restricted": "1" if restricted else "0",
        }
        with path.open("rb") as f:
            files = {"file": (path.name, f, mime)}
            with httpx.Client(timeout=timeout) as client:
                r = client.post(
                    f"{self.base_url}/api/upload",
                    data=data,
                    files=files,
                    headers=self._headers(),
                )
                r.raise_for_status()
                return r.json()

    def ingest(
        self,
        items: list[dict[str, Any]],
        *,
        tags: list[str] | None = None,
        restricted: bool = False,
        use_jasna: bool = False,
        timeout: float = 60.0,
    ) -> dict[str, Any]:
        body = {
            "items": items,
            "tags": tags or [],
            "restricted": restricted,
            "use_jasna": use_jasna,
        }
        with httpx.Client(timeout=timeout) as client:
            r = client.post(
                f"{self.base_url}/api/ingest",
                json=body,
                headers={**self._headers(), "Content-Type": "application/json"},
            )
            r.raise_for_status()
            return r.json()
