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
    # Client confirmed: store even if iPhone Safari cannot play it
    allow_ios_incompatible: bool = False


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
    # Default allow_ios_incompatible for items that omit the flag
    allow_ios_incompatible: bool = False


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
    duration_sec: float | None = None
    max_progress: float = 0.0
    last_position_sec: float = 0.0
    tags: list[str] = Field(default_factory=list)
    review: str = ""
    created_at: datetime | None = None
    file_url: str
    thumb_url: str
    series_id: int | None = None
    series_title: str = ""
    episode_index: int | None = None
    episode_count: int | None = None
    series_current_index: int | None = None

    model_config = {"from_attributes": True}


class SeriesCreate(BaseModel):
    """Create a series from media ids in click order."""

    ids: list[int] = Field(default_factory=list)
    title: str = ""


class FeedRequest(BaseModel):
    """POST /api/feed — same fields as GET; exclude_ids as int list (random persistence)."""

    mode: str = "recommend"
    limit: int = Field(default=30, le=100, ge=1)
    similar_to: int | None = None
    tag: str | None = None
    exclude_ids: list[int] = Field(default_factory=list)
    include_seed: bool = True
    include_restricted: bool = False
    include_images: bool = False
    exclude_tags: list[str] = Field(default_factory=list)


class InteractEvent(BaseModel):
    """view | dwell | skip | progress | ended — lightweight signals for recommend mode."""
    event: str = "view"  # view | dwell | skip | progress | ended
    dwell_ms: int = 0
    # Playback progress ratio 0..1 (progress/ended)
    progress: float | None = None
    # Media duration in seconds (client or probe); stored when missing/better
    duration_sec: float | None = None
    # Absolute playback clock (sec) for resume; independent of max_progress
    position_sec: float | None = None


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


class MediaDedupeRequest(BaseModel):
    """One-click remove items that reference byte-identical media files."""
    dry_run: bool = False


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
    # Free-text review note; max 2000 chars; whitespace-only clears to ""
    review: str | None = None


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


class MediaConcatRequest(BaseModel):
    """Concatenate library video items in order into one new video (ffmpeg)."""
    ids: list[int] = Field(default_factory=list)
    title: str = ""
    tags: list[str] = Field(default_factory=list)
    # Delete source media rows after successful concat
    delete_sources: bool = False
    use_jasna: bool = False
    restricted: bool = False


class MediaReclassifyRequest(BaseModel):
    """Re-probe on-disk files and fix media_type (ignore extension). Empty ids = all video/audio."""
    ids: list[int] = Field(default_factory=list)
    # When true, also scan image-looking rows that may be mislabeled
    include_images: bool = False


class ProbeUrlRequest(BaseModel):
    """Download a remote URL to a temp file and classify by content (ffprobe/magic)."""
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    # Soft cap for probe download (bytes). 0 = default small head (~4MiB), not full file.
    # Set large only when you intentionally want a near-full download for probe.
    max_bytes: int = 0
    # When Content-Length is known and file is larger than max_bytes, also fetch
    # this many trailing bytes (helps moov-at-end MP4). 0 = default 1MiB; -1 = disable.
    tail_bytes: int = 0


class TagSuggestRequest(BaseModel):
    title: str = ""
    url: str = ""
    media_type: str = ""
    source_page: str = ""
    # optional autocomplete query (when set, also returns `matches`)
    query: str = ""
    limit: int = 12


class DlnaPlayRequest(BaseModel):
    """Cast current library item to a discovered DLNA renderer."""
    device_id: str
    media_id: int
    # Server-side playback after end: once (default) | loop. No auto-next / no TV playlist.
    mode: str = "once"


class DlnaSeekRequest(BaseModel):
    """Seek currently playing media on a DLNA renderer (scrub sync from phone)."""
    device_id: str
    position_sec: float


class DlnaControlRequest(BaseModel):
    """Transport / volume on an active cast: pause / play / stop / volume / get_volume."""
    device_id: str
    action: str  # pause | play | stop | volume | get_volume
    volume: float | None = None
