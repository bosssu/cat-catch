"""Ingest content-hash gate: byte-identical upload does not create a second item."""
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

    from app.main import app

    with TestClient(app) as c:
        c.medias_dir = medias_dir  # type: ignore[attr-defined]
        yield c

    if db_mod._engine is not None:
        try:
            db_mod._engine.dispose()
        except Exception:
            pass
    db_mod._engine = None
    db_mod.SessionLocal = None
    config.get_settings.cache_clear()


def test_upload_content_duplicate_returns_existing(client: TestClient):
    payload = b"unique-payload-" + uuid4().hex.encode() * 20
    files1 = {"file": ("a.mp4", payload, "video/mp4")}
    r1 = client.post(
        "/api/upload",
        data={"title": "first", "remux": "0", "media_type": "video"},
        files=files1,
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1.get("duplicate") in (False, None)
    mid = body1["media_id"]
    assert mid

    files2 = {"file": ("b-other-name.mp4", payload, "video/mp4")}
    r2 = client.post(
        "/api/upload",
        data={"title": "second", "remux": "0", "media_type": "video", "tags": '["extra"]'},
        files=files2,
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["duplicate"] is True
    assert body2["media_id"] == mid
    assert "content_duplicate" in (body2.get("note") or "")

    listed = client.get("/api/media?limit=50")
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == mid
    # tags from second upload should be merged onto the kept item
    assert "extra" in (items[0].get("tags") or [])

    # only one media file should remain under medias/
    media_files = [p for p in client.medias_dir.rglob("*") if p.is_file()]  # type: ignore[attr-defined]
    assert len(media_files) == 1


def test_upload_different_content_creates_two(client: TestClient):
    a = b"content-A-" + uuid4().hex.encode()
    b = b"content-B-" + uuid4().hex.encode()
    r1 = client.post(
        "/api/upload",
        data={"title": "a", "remux": "0", "media_type": "video"},
        files={"file": ("a.bin", a, "application/octet-stream")},
    )
    r2 = client.post(
        "/api/upload",
        data={"title": "b", "remux": "0", "media_type": "video"},
        files={"file": ("b.bin", b, "application/octet-stream")},
    )
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["media_id"] != r2.json()["media_id"]
    assert not r2.json().get("duplicate")
