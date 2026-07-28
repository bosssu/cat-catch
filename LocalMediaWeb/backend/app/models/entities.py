from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MediaItem(Base):
    __tablename__ = "media_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(128), index=True, default="default")
    title: Mapped[str] = mapped_column(String(512), default="")
    media_type: Mapped[str] = mapped_column(String(32), index=True, default="image")
    rel_path: Mapped[str] = mapped_column(String(1024), unique=True)
    source_url: Mapped[str] = mapped_column(String(2048), default="", index=True)
    url_hash: Mapped[str] = mapped_column(String(64), index=True, default="")
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    mime: Mapped[str] = mapped_column(String(128), default="")
    thumb_rel: Mapped[str] = mapped_column(String(1024), default="")
    partial: Mapped[bool] = mapped_column(Boolean, default=False)
    warning: Mapped[str] = mapped_column(Text, default="")
    # JSON array string, e.g. ["video","bilibili"] — unlimited tags (app layer normalize)
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    # Feed / personalization (single-user LAN; "like" ≈ favorite)
    liked: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    like_count: Mapped[int] = mapped_column(Integer, default=0)  # toggles still 0/1; kept for UI
    skip_count: Mapped[int] = mapped_column(Integer, default=0)
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    dwell_ms_total: Mapped[int] = mapped_column(Integer, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class DownloadJob(Base):
    __tablename__ = "download_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(128), default="default")
    url: Mapped[str] = mapped_column(String(2048), default="")
    media_type: Mapped[str] = mapped_column(String(32), default="video")
    title: Mapped[str] = mapped_column(String(512), default="")
    source_page: Mapped[str] = mapped_column(String(2048), default="")
    # JSON string of headers (short-lived; may be cleared after success)
    headers_json: Mapped[str] = mapped_column(Text, default="{}")
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    status: Mapped[str] = mapped_column(String(32), index=True, default="queued")
    http_status: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str] = mapped_column(Text, default="")
    client_fallback_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    segments_total: Mapped[int] = mapped_column(Integer, default=0)
    segments_done: Mapped[int] = mapped_column(Integer, default=0)
    media_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    url_hash: Mapped[str] = mapped_column(String(64), index=True, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )
