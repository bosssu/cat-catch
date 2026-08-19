from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MediaType(str, Enum):
    IMAGE = "image"
    GIF = "gif"
    VIDEO = "video"
    AUDIO = "audio"


class SourceKind(str, Enum):
    NETWORK = "network"
    CACHE = "cache"
    FILE = "file"
    SCREENSHOT = "screenshot"
    RECORD = "record"
    EXTENSION = "extension"
    DEMO = "demo"


@dataclass
class MediaCandidate:
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    media_type: MediaType = MediaType.IMAGE
    source_kind: SourceKind = SourceKind.FILE
    extension_id: str | None = None
    process_name: str = ""
    pid: int | None = None
    title: str = ""
    source_url: str = ""
    local_path: str | None = None
    bytes_hint: int | None = None
    width: int | None = None
    height: int | None = None
    mime: str | None = None
    captured_at: datetime = field(default_factory=utcnow)
    score: float = 0.0
    thumb_path: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    filtered_out: bool = False
    filter_reason: str = ""
    selected: bool = False

    @property
    def min_edge(self) -> int | None:
        if self.width is None or self.height is None:
            return None
        return min(self.width, self.height)

    def display_name(self) -> str:
        if self.title:
            return self.title
        if self.source_url:
            return self.source_url.rsplit("/", 1)[-1][:80]
        if self.local_path:
            from pathlib import Path

            return Path(self.local_path).name
        return self.id


@dataclass
class CaptureSession:
    hwnd: int
    pid: int | None
    process_name: str
    window_title: str = ""
    started_at: datetime = field(default_factory=utcnow)
    candidates: list[MediaCandidate] = field(default_factory=list)
    extension_ids: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


@dataclass
class RecentItem:
    id: str
    title: str
    process_name: str
    media_type: str
    status: str  # success | fail | duplicate
    media_id: int | None = None
    error: str = ""
    source_url: str = ""
    local_path: str | None = None
    thumb_path: str | None = None
    created_at: datetime = field(default_factory=utcnow)


@dataclass
class WindowInfo:
    hwnd: int
    pid: int | None
    process_name: str
    title: str
    rect: tuple[int, int, int, int]  # left, top, right, bottom
