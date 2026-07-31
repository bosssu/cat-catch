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
    # After successful download, run jasna demosaic (video only)
    use_jasna: bool = False
    # Mark item with 限制级 tag on ingest
    restricted: bool = False


class IngestRequest(BaseModel):
    # Deprecated: ignored; kept for old clients. Files store under Medias/ flat.
    category: str = "default"
    items: list[IngestItem]
    # Default tags applied to items that omit tags
    tags: list[str] = Field(default_factory=list)
    # Default use_jasna for items that omit the flag
    use_jasna: bool = False
    # Default restricted for items that omit the flag
    restricted: bool = False


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
    use_jasna: bool = False
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class JasnaJobOut(BaseModel):
    id: int
    media_id: int
    status: str
    progress: float
    error_message: str = ""
    input_path: str = ""
    output_path: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class TagsUpdate(BaseModel):
    tags: list[str] = Field(default_factory=list)


class TagsBatchUpdate(BaseModel):
    ids: list[int]
    tags: list[str] = Field(default_factory=list)
    mode: Literal["replace", "merge"] = "merge"


class MediaDeleteBatch(BaseModel):
    ids: list[int] = Field(default_factory=list)


class MediaJasnaBatch(BaseModel):
    """Enqueue jasna demosaic for selected media ids (video/m3u8 only)."""
    ids: list[int] = Field(default_factory=list)
    force: bool = False


class MediaPatch(BaseModel):
    """Partial update for a single media item."""
    title: str | None = None
    tags: list[str] | None = None
    # When set, add/remove the 限制级 tag (applied after optional tags replace)
    restricted: bool | None = None


class AvMatchRequest(BaseModel):
    """Find duration-matched video_only + audio_only pairs in the library."""
    # Optional subset; empty = scan all complete video/audio files
    ids: list[int] = Field(default_factory=list)
    abs_tol_sec: float = 0.45
    rel_tol: float = 0.02
    min_score: float = 0.97
    # When True, also consider videos that already contain an audio stream
    include_av_videos: bool = False


class AvMergePair(BaseModel):
    video_id: int
    audio_id: int


class AvMergeRequest(BaseModel):
    """Merge library video+audio items into new playable videos."""
    pairs: list[AvMergePair] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    # Optional title template; {video} {audio} placeholders
    title: str = ""
    delete_sources: bool = False


class MediaReclassifyRequest(BaseModel):
    """Re-probe on-disk files and fix media_type (ignore extension). Empty ids = all video/audio."""
    ids: list[int] = Field(default_factory=list)
    # When true, also scan image-looking rows that may be mislabeled
    include_images: bool = False


class ProbeUrlRequest(BaseModel):
    """Download a remote URL to a temp file and classify by content (ffprobe/magic)."""
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    # Soft cap so huge files don't fill disk during probe (bytes); 0 = use max_file_bytes
    max_bytes: int = 0


class TagSuggestRequest(BaseModel):
    title: str = ""
    url: str = ""
    media_type: str = ""
    source_page: str = ""
    # optional autocomplete query (when set, also returns `matches`)
    query: str = ""
    limit: int = 12
