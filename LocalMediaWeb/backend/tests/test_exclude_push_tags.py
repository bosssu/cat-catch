"""Feed/list hide items carrying client exclude_tags."""
from __future__ import annotations

from pathlib import Path
import tempfile
import uuid

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    root = Path(tempfile.gettempdir()) / f"lmw_ex_tags_{uuid.uuid4().hex}"
    data_dir = root / "data"
    medias_dir = root / "medias"
    data_dir.mkdir(parents=True)
    medias_dir.mkdir(parents=True)

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

    from app.main import app

    with TestClient(app) as c:
        yield c

    if db_mod._engine is not None:
        try:
            db_mod._engine.dispose()
        except Exception:
            pass
    db_mod._engine = None
    db_mod.SessionLocal = None
    config.get_settings.cache_clear()


def _seed():
    from app.core.db import SessionLocal
    from app.models.entities import MediaItem
    from app.services.tags import tags_to_json

    db = SessionLocal()
    try:
        rows = [
            ("plain", []),
            ("spoiler", ["spoilers"]),
            ("work", ["work"]),
            ("both", ["spoilers", "work"]),
        ]
        ids = {}
        for title, tags in rows:
            m = MediaItem(
                title=title,
                media_type="video",
                rel_path=f"{title}.mp4",
                mime="video/mp4",
                file_size=100,
                tags_json=tags_to_json(tags),
            )
            db.add(m)
            db.flush()
            ids[title] = int(m.id)
        db.commit()
        return ids
    finally:
        db.close()


def test_feed_excludes_listed_tags(client: TestClient):
    ids = _seed()
    r = client.get(
        "/api/feed",
        params={
            "mode": "recent",
            "limit": 20,
            "include_images": "true",
            "include_restricted": "true",
            "exclude_tags": "spoilers,work",
        },
    )
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert ids["plain"] in got
    assert ids["spoiler"] not in got
    assert ids["work"] not in got
    assert ids["both"] not in got


def test_media_list_excludes_tags(client: TestClient):
    ids = _seed()
    r = client.get(
        "/api/media",
        params={"limit": 50, "exclude_tags": "spoilers"},
    )
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert ids["plain"] in got
    assert ids["work"] in got
    assert ids["spoiler"] not in got
    assert ids["both"] not in got


def test_empty_tags_not_excluded(client: TestClient):
    from app.core.db import SessionLocal
    from app.models.entities import MediaItem
    from app.services.tags import tags_to_json

    db = SessionLocal()
    try:
        a = MediaItem(
            title="has",
            media_type="video",
            rel_path="has.mp4",
            mime="video/mp4",
            file_size=1,
            tags_json=tags_to_json(["spoilers"]),
        )
        b = MediaItem(
            title="empty",
            media_type="video",
            rel_path="empty.mp4",
            mime="video/mp4",
            file_size=1,
            tags_json="[]",
        )
        db.add_all([a, b])
        db.commit()
        empty_id = int(b.id)
        has_id = int(a.id)
    finally:
        db.close()

    r = client.get("/api/media", params={"limit": 50, "exclude_tags": "spoilers"})
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert empty_id in got
    assert has_id not in got


def test_exclude_is_exact_tag_not_substring_or_alias(client: TestClient):
    from app.core.db import SessionLocal
    from app.models.entities import MediaItem

    db = SessionLocal()
    try:
        rows = [
            ("only-video", '["video"]'),
            ("only-cn", '["视频"]'),
            ("other", '["cats"]'),
        ]
        ids = {}
        for title, tj in rows:
            m = MediaItem(
                title=title,
                media_type="video",
                rel_path=f"{title}.mp4",
                mime="video/mp4",
                file_size=1,
                tags_json=tj,
            )
            db.add(m)
            db.flush()
            ids[title] = int(m.id)
        db.commit()
    finally:
        db.close()

    r = client.get("/api/media", params={"limit": 50, "exclude_tags": "视频"})
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert ids["only-cn"] not in got
    assert ids["only-video"] in got
    assert ids["other"] in got


def test_feed_post_exclude_tags(client: TestClient):
    ids = _seed()
    r = client.post(
        "/api/feed",
        json={
            "mode": "recent",
            "limit": 20,
            "include_images": True,
            "include_restricted": True,
            "exclude_tags": ["work"],
        },
    )
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert ids["plain"] in got
    assert ids["spoiler"] in got
    assert ids["work"] not in got
    assert ids["both"] not in got
