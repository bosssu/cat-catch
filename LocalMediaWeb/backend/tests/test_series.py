"""Series grouping + feed mode=series + cursor + delete detach."""
from __future__ import annotations

import shutil
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    root = Path(__file__).resolve().parent / "_tmp_series"
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

    session = db_mod.session_scope()
    ids = []
    try:
        for i in range(4):
            item = MediaItem(
                title=f"ep-{i + 1}",
                media_type="video",
                rel_path=f"series-{uuid4().hex}.mp4",
                source_url=f"https://example.com/s{i}",
                mime="video/mp4",
                tags_json="[]",
                duration_sec=120.0,
            )
            session.add(item)
            session.flush()
            ids.append(int(item.id))
        session.commit()
    finally:
        session.close()

    from app.main import app

    with TestClient(app) as c:
        c.media_ids = ids  # type: ignore[attr-defined]
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


def test_create_series_and_feed_lists_one_item(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    r = client.post("/api/series", json={"ids": ids[:3], "title": "Show A"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["episode_count"] == 3
    assert [e["id"] for e in body["episodes"]] == ids[:3]
    assert body["episodes"][0]["episode_index"] == 1
    assert body["episodes"][2]["episode_index"] == 3

    feed = client.get("/api/feed?mode=series&limit=10")
    assert feed.status_code == 200
    items = feed.json()["items"]
    assert len(items) == 1
    assert items[0]["series_id"] == body["id"]
    assert items[0]["episode_count"] == 3

    listed = client.get("/api/series?limit=20")
    assert listed.status_code == 200, listed.text
    rows = listed.json()["items"]
    assert len(rows) == 1
    assert rows[0]["id"] == body["id"]
    assert rows[0]["episode_count"] == 3
    assert rows[0]["cover"]["id"] == ids[0]


def test_interact_updates_series_cursor(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    r = client.post("/api/series", json={"ids": ids[:3], "title": "Show B"})
    sid = r.json()["id"]
    mid = ids[1]
    ir = client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "progress": 0.4, "position_sec": 33, "duration_sec": 120},
    )
    assert ir.status_code == 200
    g = client.get(f"/api/series/{sid}").json()
    assert g["current_media_id"] == mid
    assert g["current_episode_index"] == 2
    assert ir.json()["last_position_sec"] == 33


def test_delete_media_unbinds_and_drops_short_series(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    r = client.post("/api/series", json={"ids": ids[:2], "title": "Short"})
    sid = r.json()["id"]
    d = client.delete(f"/api/media/{ids[0]}")
    assert d.status_code == 200
    g = client.get(f"/api/series/{sid}")
    assert g.status_code == 404


def test_reject_duplicate_membership_and_too_few(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    a = client.post("/api/series", json={"ids": ids[:2], "title": "A"})
    assert a.status_code == 200
    b = client.post("/api/series", json={"ids": [ids[0], ids[2]], "title": "B"})
    assert b.status_code == 400
    c = client.post("/api/series", json={"ids": [ids[3]], "title": "C"})
    assert c.status_code == 400
