from __future__ import annotations

import json
import mimetypes
import time
from pathlib import Path
from typing import Any, Callable

import httpx

RETRY_STATUS = {408, 425, 429, 500, 502, 503, 504}


def health(base_url: str, token: str = "", timeout: float = 5.0) -> dict[str, Any]:
    headers = _headers(token)
    with httpx.Client(timeout=timeout) as client:
        r = client.get(base_url.rstrip("/") + "/api/health", headers=headers)
        r.raise_for_status()
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}


def upload(
    base_url: str,
    file_path: Path,
    *,
    token: str = "",
    title: str = "",
    source_url: str = "",
    remux: bool = False,
    timeout: float = 600.0,
) -> dict[str, Any]:
    if not file_path.is_file():
        raise FileNotFoundError(str(file_path))
    mime = mimetypes.guess_type(file_path.name)[0] or "video/mp4"
    data = {
        "category": "default",
        "title": title or file_path.stem,
        "source_url": source_url or "",
        "media_type": "video",
        "remux": "1" if remux else "0",
        "tags": json.dumps(["youtube"] if "youtu" in (source_url or "").lower() else [], ensure_ascii=False),
        "use_jasna": "0",
        "restricted": "0",
    }
    headers = _headers(token)
    with file_path.open("rb") as f:
        files = {"file": (file_path.name, f, mime)}
        with httpx.Client(timeout=timeout) as client:
            r = client.post(
                base_url.rstrip("/") + "/api/upload",
                data=data,
                files=files,
                headers=headers,
            )
            r.raise_for_status()
            return r.json()


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code if exc.response is not None else 0
        return code in RETRY_STATUS
    return False


def upload_with_retry(
    base_url: str,
    file_path: Path,
    *,
    token: str = "",
    title: str = "",
    source_url: str = "",
    remux: bool = False,
    timeout: float = 600.0,
    attempts: int = 3,
    backoff: float = 2.0,
    on_retry: Callable[[int, int, float, BaseException], None] | None = None,
) -> dict[str, Any]:
    last: BaseException | None = None
    n = max(1, int(attempts))
    wait0 = max(0.2, float(backoff))
    for i in range(1, n + 1):
        try:
            return upload(
                base_url,
                file_path,
                token=token,
                title=title,
                source_url=source_url,
                remux=remux,
                timeout=timeout,
            )
        except Exception as e:  # noqa: BLE001
            last = e
            if i >= n or not is_retryable(e):
                raise
            wait = wait0 * (2 ** (i - 1))
            if on_retry:
                on_retry(i, n, wait, e)
            time.sleep(wait)
    assert last is not None
    raise last


def _headers(token: str) -> dict[str, str]:
    h: dict[str, str] = {}
    if token:
        h["X-LMW-Token"] = token
        h["Authorization"] = f"Bearer {token}"
    return h
