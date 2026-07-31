"""Tests for one-click content-hash dedupe of identical media files."""
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

    payload = b"identical-video-bytes-" + uuid4().hex.encode()
    other = b"different-video-bytes-" + uuid4().hex.encode()

    ids = {}
    session = db_mod.session_scope()
    try:
        # Three copies of the same content; keep should be the liked one
        for i, (name, liked) in enumerate(
            [
                ("a.mp4", False),
                ("b.mp4", True),
                ("c.mp4", False),
            ]
        ):
            rel = f"dup-{uuid4().hex}-{name}"
            (medias_dir / rel).write_bytes(payload)
            m = MediaItem(
                title=f"dup-{i}",
                media_type="video",
                rel_path=rel,
                source_url=f"https://example.com/{name}",
                mime="video/mp4",
                file_size=len(payload),
                tags_json="[]",
                liked=liked,
                like_count=1 if liked else 0,
            )
            session.add(m)
            session.flush()
            ids[name] = m.id

        # Unique file — must survive
        rel_u = f"unique-{uuid4().hex}.mp4"
        (medias_dir / rel_u).write_bytes(other)
        u = MediaItem(
            title="unique",
            media_type="video",
            rel_path=rel_u,
            source_url="https://example.com/unique",
            mime="video/mp4",
            file_size=len(other),
            tags_json="[]",
        )
        session.add(u)
        session.commit()
        ids["unique"] = u.id
        ids["liked"] = ids["b.mp4"]
    finally:
        session.close()

    from app.main import app

    with TestClient(app) as c:
        c.ids = ids  # type: ignore[attr-defined]
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


def test_dedupe_dry_run_then_delete(client: TestClient):
    ids = client.ids  # type: ignore[attr-defined]

    r = client.post("/api/media/dedupe", json={"dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True
    assert body["duplicate_groups"] == 1
    assert body["would_delete"] == 2
    assert set(body["deleted_ids"]) == {ids["a.mp4"], ids["c.mp4"]}
    assert body["kept_ids"] == [ids["liked"]]

    # dry_run must not delete files
    medias = list(client.medias_dir.iterdir())  # type: ignore[attr-defined]
    assert len(medias) == 4

    r2 = client.post("/api/media/dedupe", json={"dry_run": False})
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["deleted"] == 2
    assert set(body2["deleted_ids"]) == {ids["a.mp4"], ids["c.mp4"]}

    listed = client.get("/api/media?limit=100")
    assert listed.status_code == 200
    remaining = {it["id"] for it in listed.json()["items"]}
    assert remaining == {ids["liked"], ids["unique"]}


def test_dedupe_noop_when_unique(client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # After first real dedupe in other test the fixture is fresh per test;
    # call execute once then again → second pass no groups
    r1 = client.post("/api/media/dedupe", json={"dry_run": False})
    assert r1.status_code == 200
    r2 = client.post("/api/media/dedupe", json={"dry_run": True})
    assert r2.status_code == 200
    assert r2.json()["duplicate_groups"] == 0
    assert r2.json()["would_delete"] == 0
