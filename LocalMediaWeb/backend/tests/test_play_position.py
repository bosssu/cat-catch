"""Resume position via /interact position_sec (independent of max_progress)."""
from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    root = Path(__file__).resolve().parent / "_tmp_play_pos"
    root.mkdir(parents=True, exist_ok=True)
    data_dir = root / "data"
    medias_dir = root / "medias"
    data_dir.mkdir(exist_ok=True)
    medias_dir.mkdir(exist_ok=True)

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

    rel = f"pos-test-{uuid4().hex}.mp4"
    session = db_mod.session_scope()
    try:
        item = MediaItem(
            title="pos-test-item",
            media_type="video",
            rel_path=rel,
            source_url="https://example.com/pos-test",
            mime="video/mp4",
            tags_json="[]",
            duration_sec=600.0,
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
        yield c

    if db_mod._engine is not None:
        try:
            db_mod._engine.dispose()
        except Exception:
            pass
    db_mod._engine = None
    db_mod.SessionLocal = None
    config.get_settings.cache_clear()
    shutil.rmtree(root, ignore_errors=True)


def test_position_saved_and_can_go_backwards(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    r = client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "progress": 0.5, "position_sec": 240.0},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_position_sec"] == 240.0
    assert body["max_progress"] == 0.5

    r = client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "progress": 0.2, "position_sec": 80.0},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_position_sec"] == 80.0
    assert body["max_progress"] == 0.5


def test_ended_clears_last_position(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "position_sec": 100.0},
    )
    r = client.post(f"/api/media/{mid}/interact", json={"event": "ended", "progress": 1})
    assert r.status_code == 200, r.text
    assert r.json()["last_position_sec"] == 0.0
    assert r.json()["max_progress"] == 1.0


def test_get_media_includes_last_position(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "position_sec": 33.5},
    )
    r = client.get(f"/api/media/{mid}")
    assert r.status_code == 200, r.text
    assert abs(r.json()["last_position_sec"] - 33.5) < 1e-6
