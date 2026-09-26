"""In-place video replace keeps the same media id."""
from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


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

    rel = f"keep-id-{uuid4().hex}.mp4"
    (medias_dir / rel).write_bytes(b"old-video-bytes-0123456789abcdef")
    session = db_mod.session_scope()
    try:
        item = MediaItem(
            title="keep-me",
            media_type="video",
            rel_path=rel,
            source_url="https://example.com/keep",
            mime="video/mp4",
            file_size=32,
            tags_json='["限制级"]',
            liked=True,
            last_position_sec=12.5,
            duration_sec=10.0,
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        media_id = item.id
    finally:
        session.close()

    from app.main import app

    with TestClient(app) as c:
        c.media_id = media_id  # type: ignore[attr-defined]
        c.medias_dir = medias_dir  # type: ignore[attr-defined]
        c.rel = rel  # type: ignore[attr-defined]
        yield c

    if db_mod._engine is not None:
        try:
            db_mod._engine.dispose()
        except Exception:
            pass
    db_mod._engine = None
    db_mod.SessionLocal = None


def test_replace_file_keeps_id_and_metadata(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from app.services import replace_file as rf

    def fake_classify(path, hinted=None, content_type=None):
        return {
            "media_type": "video",
            "has_video": True,
            "method": "ffprobe",
            "mime": "video/mp4",
            "duration_sec": 33.0,
        }

    monkeypatch.setattr(rf, "classify_media_file", fake_classify)
    monkeypatch.setattr(rf, "generate_thumb", lambda *a, **k: "")

    new_bytes = b"new-demosaic-video-bytes-zzzzzzzz"
    r = client.post(
        f"/api/media/{client.media_id}/file",
        files={"file": ("out.mp4", new_bytes, "video/mp4")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media_id"] == client.media_id
    item = body["item"]
    assert item["id"] == client.media_id
    assert item["title"] == "keep-me"
    assert item["liked"] is True
    assert "限制级" in item["tags"]
    assert item["last_position_sec"] == 12.5
    assert item["duration_sec"] == 33.0
    assert item["file_size"] == len(new_bytes)
    stored = client.medias_dir / client.rel
    assert stored.read_bytes() == new_bytes


def test_replace_rejects_non_video(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from app.services import replace_file as rf

    monkeypatch.setattr(
        rf,
        "classify_media_file",
        lambda *a, **k: {"media_type": "audio", "has_video": False, "method": "ffprobe"},
    )
    before = (client.medias_dir / client.rel).read_bytes()
    r = client.post(
        f"/api/media/{client.media_id}/file",
        files={"file": ("out.mp4", b"not-a-video-0123456789abcdef", "video/mp4")},
    )
    assert r.status_code == 400
    assert (client.medias_dir / client.rel).read_bytes() == before
