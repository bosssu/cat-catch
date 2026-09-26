"""Sidecar SRT stays on the same media id."""
from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


SRT = "1\n00:00:01,000 --> 00:00:02,000\nhello\n"


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data_dir = tmp_path / "data"
    medias_dir = tmp_path / "medias"
    data_dir.mkdir()
    medias_dir.mkdir()

    monkeypatch.setenv("LMW_data_dir", str(data_dir))
    monkeypatch.setenv("LMW_medias_dir", str(medias_dir))
    monkeypatch.setenv("LMW_access_token", "")

    from app.core import config, db as db_mod

    monkeypatch.setattr(config, "_load_yaml", lambda: {})
    config.get_settings.cache_clear()

    if db_mod._engine is not None:
        try:
            db_mod._engine.dispose()
        except Exception:
            pass
    db_mod._engine = None
    db_mod.SessionLocal = None
    db_mod.init_db()

    from app.models.entities import MediaItem

    rel = f"sub-{uuid4().hex}.mp4"
    (medias_dir / rel).write_bytes(b"video-bytes-0123456789abcdef")
    session = db_mod.session_scope()
    try:
        item = MediaItem(
            title="clip",
            media_type="video",
            rel_path=rel,
            file_size=32,
            mime="video/mp4",
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        media_id = int(item.id)
    finally:
        session.close()

    from app.main import app

    with TestClient(app) as http:
        yield http, media_id, medias_dir / rel
    config.get_settings.cache_clear()


def test_put_get_and_keep_video(client):
    http, media_id, video = client
    before = video.read_bytes()
    put = http.put(
        f"/api/media/{media_id}/subtitle",
        content=SRT.encode("utf-8"),
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    assert put.status_code == 200, put.text
    assert put.json()["has_subtitle"] is True
    assert video.read_bytes() == before

    listed = http.get(f"/api/media/{media_id}")
    assert listed.status_code == 200
    assert listed.json()["has_subtitle"] is True

    vtt = http.get(f"/api/media/{media_id}/subtitle")
    assert vtt.status_code == 200
    assert vtt.text.startswith("WEBVTT")
    assert "00:00:01.000 --> 00:00:02.000" in vtt.text
    assert "hello" in vtt.text

    srt = http.get(f"/api/media/{media_id}/subtitle", params={"format": "srt"})
    assert "00:00:01,000" in srt.text


def test_delete_removes_subtitle(client):
    http, media_id, _video = client
    assert http.put(f"/api/media/{media_id}/subtitle", content=SRT.encode()).status_code == 200
    assert http.delete(f"/api/media/{media_id}").status_code == 200
    assert http.get(f"/api/media/{media_id}/subtitle").status_code == 404
