"""Tests for media review free-text notes (PATCH + search exclusion)."""
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

    # Avoid settings.yaml kwargs overriding LMW_* env (pydantic init > env).
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

    rel = f"review-test-{uuid4().hex}.jpg"
    session = db_mod.session_scope()
    try:
        item = MediaItem(
            title="review-test-item",
            media_type="image",
            rel_path=rel,
            source_url="https://example.com/review-test",
            mime="image/jpeg",
            tags_json="[]",
            review="",
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


def test_patch_set_and_clear_review(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    r = client.patch(f"/api/media/{mid}", json={"review": "nice shot"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["review"] == "nice shot"
    assert body["id"] == mid

    r2 = client.patch(f"/api/media/{mid}", json={"review": ""})
    assert r2.status_code == 200, r2.text
    assert r2.json()["review"] == ""

    r3 = client.patch(f"/api/media/{mid}", json={"review": "   "})
    assert r3.status_code == 200, r3.text
    assert r3.json()["review"] == ""


def test_patch_review_too_long(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    long = "x" * 2001
    r = client.patch(f"/api/media/{mid}", json={"review": long})
    assert r.status_code == 400


def test_list_media_q_does_not_match_review(client: TestClient):
    mid = client.media_id  # type: ignore[attr-defined]
    unique = "UNIQUE_REVIEW_TOKEN_ZX9Q_NEVER_IN_TITLE"
    r = client.patch(f"/api/media/{mid}", json={"review": unique})
    assert r.status_code == 200
    assert r.json()["review"] == unique

    listed = client.get("/api/media", params={"q": unique})
    assert listed.status_code == 200, listed.text
    data = listed.json()
    ids = [it["id"] for it in data.get("items", [])]
    assert mid not in ids
