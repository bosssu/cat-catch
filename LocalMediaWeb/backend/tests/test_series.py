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


def test_recreate_moves_members_and_drops_short_series(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    a = client.post("/api/series", json={"ids": ids[:2], "title": "A"})
    assert a.status_code == 200
    sid_a = a.json()["id"]
    b = client.post("/api/series", json={"ids": [ids[0], ids[2]], "title": "B"})
    assert b.status_code == 200, b.text
    body = b.json()
    assert [e["id"] for e in body["episodes"]] == [ids[0], ids[2]]
    assert client.get(f"/api/series/{sid_a}").status_code == 404
    lone = client.get(f"/api/media/{ids[1]}").json()
    assert lone["series_id"] is None
    too_few = client.post("/api/series", json={"ids": [ids[3]], "title": "C"})
    assert too_few.status_code == 400


def test_recreate_keeps_unselected_episodes(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    a = client.post("/api/series", json={"ids": ids, "title": "All"})
    sid_a = a.json()["id"]
    b = client.post("/api/series", json={"ids": ids[:2], "title": "Head"})
    assert b.status_code == 200, b.text
    assert [e["id"] for e in b.json()["episodes"]] == ids[:2]
    left = client.get(f"/api/series/{sid_a}")
    assert left.status_code == 200
    assert [e["id"] for e in left.json()["episodes"]] == ids[2:]
    assert [e["episode_index"] for e in left.json()["episodes"]] == [1, 2]


def test_series_source_interact_skips_rank_counters(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    r = client.post("/api/series", json={"ids": ids[:3], "title": "Show S"})
    sid = r.json()["id"]
    mid = ids[2]
    for body in (
        {"event": "view", "source": "series"},
        {"event": "dwell", "dwell_ms": 5000, "source": "series"},
        {"event": "skip", "source": "series"},
        {"event": "progress", "progress": 0.5, "position_sec": 44, "duration_sec": 120, "source": "series"},
    ):
        ir = client.post(f"/api/media/{mid}/interact", json=body)
        assert ir.status_code == 200, ir.text
    out = ir.json()
    assert out["view_count"] == 0
    assert out["skip_count"] == 0
    assert out["max_progress"] == 0
    assert out["last_position_sec"] == 44
    g = client.get(f"/api/series/{sid}").json()
    assert g["current_media_id"] == mid
    assert g["current_episode_index"] == 3
    bad = client.post(f"/api/media/{mid}/interact", json={"event": "nope", "source": "series"})
    assert bad.status_code == 400
    # Same item from the normal feed still counts
    nr = client.post(f"/api/media/{mid}/interact", json={"event": "view"})
    assert nr.json()["view_count"] == 1
    nr = client.post(f"/api/media/{mid}/interact", json={"event": "progress", "progress": 0.5})
    assert nr.json()["max_progress"] == 0.5


def test_bare_view_does_not_move_series_cursor(client: TestClient):
    """Opening a slide posts view; that must not steal the resume cursor (ep1 race)."""
    ids = client.media_ids  # type: ignore[attr-defined]
    r = client.post("/api/series", json={"ids": ids[:3], "title": "Show Cursor Guard"})
    sid = r.json()["id"]
    # Establish cursor on episode 2 via real progress
    mid2 = ids[1]
    ir = client.post(
        f"/api/media/{mid2}/interact",
        json={"event": "progress", "progress": 0.3, "position_sec": 20, "duration_sec": 120},
    )
    assert ir.status_code == 200
    g0 = client.get(f"/api/series/{sid}").json()
    assert g0["current_media_id"] == mid2
    assert g0["current_episode_index"] == 2
    # Bare view + dwell on episode 1 must leave cursor on episode 2
    mid1 = ids[0]
    for body in (
        {"event": "view"},
        {"event": "view", "source": "series"},
        {"event": "dwell", "dwell_ms": 8000, "source": "series"},
    ):
        vr = client.post(f"/api/media/{mid1}/interact", json=body)
        assert vr.status_code == 200, vr.text
    g1 = client.get(f"/api/series/{sid}").json()
    assert g1["current_media_id"] == mid2
    assert g1["current_episode_index"] == 2
    # ended on episode 3 may advance cursor
    mid3 = ids[2]
    er = client.post(
        f"/api/media/{mid3}/interact",
        json={"event": "ended", "progress": 1.0, "position_sec": 0, "source": "series"},
    )
    assert er.status_code == 200
    g2 = client.get(f"/api/series/{sid}").json()
    assert g2["current_media_id"] == mid3
    assert g2["current_episode_index"] == 3


def test_append_episodes_keeps_id_order_and_cursor(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    created = client.post("/api/series", json={"ids": ids[:2], "title": "Show Append"})
    assert created.status_code == 200, created.text
    sid = created.json()["id"]
    mid = ids[1]
    ir = client.post(
        f"/api/media/{mid}/interact",
        json={"event": "progress", "progress": 0.3, "position_sec": 12, "duration_sec": 120},
    )
    assert ir.status_code == 200
    r = client.post(f"/api/series/{sid}/episodes", json={"ids": [ids[2], ids[3]]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == sid
    assert body["title"] == "Show Append"
    assert [e["id"] for e in body["episodes"]] == ids
    assert [e["episode_index"] for e in body["episodes"]] == [1, 2, 3, 4]
    assert body["current_media_id"] == mid
    assert body["current_episode_index"] == 2


def test_append_moves_member_from_other_series(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    a = client.post("/api/series", json={"ids": ids[:2], "title": "A"})
    b = client.post("/api/series", json={"ids": ids[2:], "title": "B"})
    assert a.status_code == 200 and b.status_code == 200
    sid_a = a.json()["id"]
    sid_b = b.json()["id"]
    r = client.post(f"/api/series/{sid_a}/episodes", json={"ids": [ids[2]]})
    assert r.status_code == 200, r.text
    assert [e["id"] for e in r.json()["episodes"]] == [ids[0], ids[1], ids[2]]
    assert client.get(f"/api/series/{sid_b}").status_code == 404
    lone = client.get(f"/api/media/{ids[3]}").json()
    assert lone["series_id"] is None


def test_append_skips_existing_and_rejects_empty(client: TestClient):
    ids = client.media_ids  # type: ignore[attr-defined]
    created = client.post("/api/series", json={"ids": ids[:2], "title": "Keep"})
    sid = created.json()["id"]
    empty = client.post(f"/api/series/{sid}/episodes", json={"ids": []})
    assert empty.status_code == 400
    only_old = client.post(f"/api/series/{sid}/episodes", json={"ids": [ids[0]]})
    assert only_old.status_code == 400
    mixed = client.post(f"/api/series/{sid}/episodes", json={"ids": [ids[0], ids[2]]})
    assert mixed.status_code == 200, mixed.text
    assert [e["id"] for e in mixed.json()["episodes"]] == [ids[0], ids[1], ids[2]]
    missing = client.post("/api/series/999999/episodes", json={"ids": [ids[3]]})
    assert missing.status_code == 404
