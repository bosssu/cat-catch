"""Random feed: without-replacement until exhausted, then new cycle."""
from __future__ import annotations

from pathlib import Path
import tempfile
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch):
    root = Path(tempfile.gettempdir()) / f"lmw_feed_rand_{uuid.uuid4().hex}"
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


def _seed_videos(n: int) -> list[int]:
    from app.core.db import SessionLocal
    from app.models.entities import MediaItem

    db = SessionLocal()
    try:
        for i in range(n):
            db.add(
                MediaItem(
                    title=f"t{i}",
                    media_type="video",
                    rel_path=f"clip_{i}.mp4",
                    mime="video/mp4",
                    file_size=100,
                )
            )
        db.commit()
        ids = list(db.scalars(select(MediaItem.id)).all())
        return [int(x) for x in ids]
    finally:
        db.close()


def test_random_excludes_until_exhausted_then_resets(client: TestClient):
    ids = _seed_videos(6)
    assert len(ids) == 6

    r1 = client.post(
        "/api/feed",
        json={
            "mode": "random",
            "limit": 10,
            "include_images": True,
            "exclude_ids": ids[:-2],
        },
    )
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    got1 = {it["id"] for it in body1["items"]}
    assert got1 == set(ids[-2:])
    assert body1.get("random_cycle_reset") is False

    r2 = client.post(
        "/api/feed",
        json={
            "mode": "random",
            "limit": 10,
            "include_images": True,
            "exclude_ids": ids,
        },
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2.get("random_cycle_reset") is True
    got2 = {it["id"] for it in body2["items"]}
    assert got2 == set(ids)


def test_random_post_and_get_agree_on_exclude(client: TestClient):
    ids = _seed_videos(4)
    hold = ids[0]
    r = client.get(
        "/api/feed",
        params={
            "mode": "random",
            "limit": 20,
            "include_images": "true",
            "exclude_ids": str(hold),
        },
    )
    assert r.status_code == 200, r.text
    got = {it["id"] for it in r.json()["items"]}
    assert hold not in got
    assert got == set(ids) - {hold}
