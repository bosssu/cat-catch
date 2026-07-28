from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class IngestItem(BaseModel):
    url: str
    media_type: str | None = None
    title: str | None = None
    referer: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    source_page: str | None = None
    preferred_variant: str | None = "highest"
    # m3u8 / stream clip (seconds); omit or null = full playlist
    start_sec: float | None = None
    end_sec: float | None = None
    tags: list[str] = Field(default_factory=list)


class IngestRequest(BaseModel):
    # Deprecated: ignored; kept for old clients. Files store under Medias/ flat.
    category: str = "default"
    items: list[IngestItem]
    # Default tags applied to items that omit tags
    tags: list[str] = Field(default_factory=list)


class CategoryCreate(BaseModel):
    """Deprecated."""
    name: str


class MediaOut(BaseModel):
    id: int
    category: str = "default"
    title: str
    media_type: str
    source_url: str
    file_size: int
    mime: str
    partial: bool
    warning: str
    liked: bool = False
    like_count: int = 0
    skip_count: int = 0
    view_count: int = 0
    tags: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    file_url: str
    thumb_url: str

    model_config = {"from_attributes": True}


class InteractEvent(BaseModel):
    """view | dwell | skip — lightweight signals for recommend mode."""
    event: str = "view"  # view | dwell | skip
    dwell_ms: int = 0


class JobOut(BaseModel):
    id: int
    category: str = "default"
    url: str
    media_type: str
    title: str
    status: str
    http_status: int
    error_message: str
    client_fallback_allowed: bool
    progress: float
    segments_total: int
    segments_done: int
    media_id: int | None
    tags: list[str] = Field(default_factory=list)
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class TagsUpdate(BaseModel):
    tags: list[str] = Field(default_factory=list)


class TagsBatchUpdate(BaseModel):
    ids: list[int]
    tags: list[str] = Field(default_factory=list)
    mode: Literal["replace", "merge"] = "merge"


class TagSuggestRequest(BaseModel):
    title: str = ""
    url: str = ""
    media_type: str = ""
    source_page: str = ""
