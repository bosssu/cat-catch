"""Unit tests for DLNA helpers (no real SSDP on CI)."""
from __future__ import annotations

from app.services.dlna import (
    build_didl_lite,
    clear_cache,
    public_base_url_from_request,
    rel_time_to_seconds,
    seconds_to_rel_time,
    _parse_device_description,
)


SAMPLE_DESC = """<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room Box</friendlyName>
    <manufacturer>Acme</manufacturer>
    <modelName>TVBox-1</modelName>
    <UDN>uuid:test-renderer-1</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/upnp/control/AVTransport1</controlURL>
        <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
        <SCPDURL>/AVTransport.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>
"""


def test_parse_device_description():
    dev = _parse_device_description(SAMPLE_DESC, "http://192.168.1.50:49152/desc.xml")
    assert dev is not None
    assert dev.name == "Living Room Box"
    assert dev.host == "192.168.1.50"
    assert dev.control_url == "http://192.168.1.50:49152/upnp/control/AVTransport1"
    assert dev.manufacturer == "Acme"
    assert dev.id


def test_build_didl_contains_uri_and_title():
    didl = build_didl_lite(
        uri="http://192.168.1.10:8790/api/media/1/file?token=abc",
        title="Hello <world>",
        mime="video/mp4",
        media_type="video",
    )
    assert "video/mp4" in didl
    assert "object.item.videoItem" in didl
    assert "Hello &lt;world&gt;" in didl
    assert "http://192.168.1.10:8790/api/media/1/file?token=abc" in didl


def test_public_base_prefers_lan_host():
    url = public_base_url_from_request(
        host_header="192.168.1.10:8790",
        scheme="http",
        server_port=8790,
    )
    assert url == "http://192.168.1.10:8790"


def test_public_base_skips_localhost():
    url = public_base_url_from_request(
        host_header="localhost:8790",
        scheme="http",
        server_port=8790,
    )
    # Falls back to LAN IP or still builds something non-empty
    assert url.startswith("http://")
    assert "8790" in url


def test_devices_api_shape(monkeypatch):
    """Mock discover; hit FastAPI route (uses project data dirs, no system tmp)."""
    clear_cache()
    monkeypatch.setenv("LMW_access_token", "")

    from app.core import config

    monkeypatch.setattr(config, "_load_yaml", lambda: {})
    config.get_settings.cache_clear()

    from app.services import dlna as dlna_svc

    fake = dlna_svc.DlnaDevice(
        id="abc123",
        name="Fake Box",
        udn="uuid:fake",
        location="http://1.2.3.4/desc",
        control_url="http://1.2.3.4/ctrl",
        host="1.2.3.4",
    )
    monkeypatch.setattr(
        dlna_svc, "discover_devices", lambda timeout_sec=2.5, force=False: [fake]
    )

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        r = client.get("/api/dlna/devices")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        assert body["items"][0]["name"] == "Fake Box"
        assert body["items"][0]["id"] == "abc123"
        assert "cached" in body


def test_discover_cache_skips_second_scan(monkeypatch):
    clear_cache()
    from app.services import dlna as dlna_svc

    calls = {"n": 0}

    def fake_msearch(*_a, **_k):
        calls["n"] += 1
        return []

    monkeypatch.setattr(dlna_svc, "_ssdp_msearch", fake_msearch)
    a = dlna_svc.discover_devices(timeout_sec=1.0, force=False)
    b = dlna_svc.discover_devices(timeout_sec=1.0, force=False)
    assert a == []
    assert b == []
    # First open scans; second must not SSDP again
    assert calls["n"] > 0
    first_calls = calls["n"]
    dlna_svc.discover_devices(timeout_sec=1.0, force=False)
    assert calls["n"] == first_calls
    # Force refresh rescans
    dlna_svc.discover_devices(timeout_sec=1.0, force=True)
    assert calls["n"] > first_calls


def test_seconds_to_rel_time():
    assert seconds_to_rel_time(0) == "0:00:00"
    assert seconds_to_rel_time(65) == "0:01:05"
    assert seconds_to_rel_time(3661) == "1:01:01"
    assert seconds_to_rel_time(-3) == "0:00:00"


def test_rel_time_to_seconds():
    assert rel_time_to_seconds("0:00:00") == 0.0
    assert rel_time_to_seconds("0:01:05") == 65.0
    assert rel_time_to_seconds("1:01:01") == 3661.0
    assert rel_time_to_seconds("0:02:05.123") == 125.0
    assert rel_time_to_seconds("NOT_IMPLEMENTED") is None
    assert rel_time_to_seconds("") is None


def test_seek_position_sends_rel_time(monkeypatch):
    from app.services import dlna as dlna_svc

    posts = []

    def fake_soap(control_url, action, body_inner, timeout=8.0):
        posts.append({"url": control_url, "action": action, "body": body_inner})

    monkeypatch.setattr(dlna_svc, "_soap_post", fake_soap)
    dev = dlna_svc.DlnaDevice(
        id="x",
        name="Box",
        udn="uuid:x",
        location="http://1.2.3.4/d",
        control_url="http://1.2.3.4/c",
        host="1.2.3.4",
    )
    target = dlna_svc.seek_position(dev, 125.4)
    assert target == "0:02:05"
    assert len(posts) == 1
    assert posts[0]["action"] == "Seek"
    assert "REL_TIME" in posts[0]["body"]
    assert "0:02:05" in posts[0]["body"]


def test_seek_api(monkeypatch):
    clear_cache()
    monkeypatch.setenv("LMW_access_token", "")
    from app.core import config

    monkeypatch.setattr(config, "_load_yaml", lambda: {})
    config.get_settings.cache_clear()

    from app.services import dlna as dlna_svc

    fake = dlna_svc.DlnaDevice(
        id="seekdev",
        name="Seek Box",
        udn="uuid:seek",
        location="http://9.9.9.9/d",
        control_url="http://9.9.9.9/c",
        host="9.9.9.9",
    )
    # Seed cache so find_device works without SSDP
    with dlna_svc._cache_lock:
        dlna_svc._cache_devices = [fake]
        dlna_svc._cache_scanned = True
        dlna_svc._cache_at = 1.0

    monkeypatch.setattr(
        dlna_svc, "seek_position", lambda device, position_sec: "0:00:42"
    )

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        r = client.post(
            "/api/dlna/seek",
            json={"device_id": "seekdev", "position_sec": 42},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["target"] == "0:00:42"
        assert body["device_id"] == "seekdev"


def test_pause_play_stop_soap(monkeypatch):
    from app.services import dlna as dlna_svc

    posts = []

    def fake_soap(control_url, action, body_inner, timeout=8.0):
        posts.append(action)

    monkeypatch.setattr(dlna_svc, "_soap_post", fake_soap)
    dev = dlna_svc.DlnaDevice(
        id="c",
        name="Box",
        udn="uuid:c",
        location="http://1.1.1.1/d",
        control_url="http://1.1.1.1/c",
        host="1.1.1.1",
    )
    dlna_svc.pause_device(dev)
    dlna_svc.play_device(dev)
    dlna_svc.stop_device(dev)
    assert posts == ["Pause", "Play", "Stop"]


def test_control_api(monkeypatch):
    clear_cache()
    monkeypatch.setenv("LMW_access_token", "")
    from app.core import config

    monkeypatch.setattr(config, "_load_yaml", lambda: {})
    config.get_settings.cache_clear()

    from app.services import dlna as dlna_svc

    fake = dlna_svc.DlnaDevice(
        id="ctrldev",
        name="Ctrl Box",
        udn="uuid:ctrl",
        location="http://8.8.8.8/d",
        control_url="http://8.8.8.8/c",
        host="8.8.8.8",
    )
    with dlna_svc._cache_lock:
        dlna_svc._cache_devices = [fake]
        dlna_svc._cache_scanned = True
        dlna_svc._cache_at = 1.0

    calls = []
    monkeypatch.setattr(dlna_svc, "pause_device", lambda d: calls.append("pause"))
    monkeypatch.setattr(dlna_svc, "play_device", lambda d: calls.append("play"))
    monkeypatch.setattr(dlna_svc, "stop_device", lambda d: calls.append("stop"))

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        for act in ("pause", "play", "stop"):
            r = client.post(
                "/api/dlna/control",
                json={"device_id": "ctrldev", "action": act},
            )
            assert r.status_code == 200, r.text
            assert r.json()["action"] == act
        assert calls == ["pause", "play", "stop"]
        bad = client.post(
            "/api/dlna/control",
            json={"device_id": "ctrldev", "action": "explode"},
        )
        assert bad.status_code == 400


def test_normalize_play_mode():
    from app.services import dlna as dlna_svc

    assert dlna_svc.normalize_play_mode(None) == "once"
    assert dlna_svc.normalize_play_mode("loop") == "loop"
    assert dlna_svc.normalize_play_mode("LOOP") == "loop"
    assert dlna_svc.normalize_play_mode("next") == "once"
    assert dlna_svc.normalize_play_mode("auto") == "once"


def test_loop_session_recasts_on_stopped(monkeypatch):
    """mode=loop watcher re-pushes same URI when renderer reports STOPPED."""
    import time
    from app.services import dlna as dlna_svc

    dlna_svc.clear_sessions_for_tests()
    monkeypatch.setattr(dlna_svc, "_LOOP_POLL_SEC", 0.05)
    monkeypatch.setattr(dlna_svc, "_LOOP_GRACE_SEC", 0.05)

    cast_calls = {"n": 0}

    def fake_cast(device, **kwargs):
        cast_calls["n"] += 1

    monkeypatch.setattr(dlna_svc, "cast_uri", fake_cast)
    monkeypatch.setattr(
        dlna_svc,
        "get_transport_info",
        lambda device: {"state": "STOPPED", "status": "OK", "speed": "1"},
    )
    monkeypatch.setattr(
        dlna_svc,
        "get_position_info",
        lambda device: {
            "rel_time": "0:00:00",
            "track_duration": "0:01:00",
            "track_uri": "http://x/a",
            "rel_sec": 0.0,
            "duration_sec": 60.0,
        },
    )

    dev = dlna_svc.DlnaDevice(
        id="loopdev",
        name="Loop Box",
        udn="uuid:loop",
        location="http://7.7.7.7/d",
        control_url="http://7.7.7.7/c",
        host="7.7.7.7",
    )
    # start_cast_session does not call cast_uri; watcher will
    dlna_svc.start_cast_session(
        dev,
        media_id=42,
        mode="loop",
        uri="http://lan/api/media/42/file",
        title="Clip",
        mime="video/mp4",
        media_type="video",
    )
    deadline = time.time() + 2.0
    while cast_calls["n"] < 1 and time.time() < deadline:
        time.sleep(0.05)
    assert cast_calls["n"] >= 1
    dlna_svc.clear_cast_session("loopdev")
    # After clear, no more growth after a short wait
    n = cast_calls["n"]
    time.sleep(0.2)
    assert cast_calls["n"] == n


def test_once_session_no_watcher_recast(monkeypatch):
    import time
    from app.services import dlna as dlna_svc

    dlna_svc.clear_sessions_for_tests()
    cast_calls = {"n": 0}
    monkeypatch.setattr(dlna_svc, "cast_uri", lambda *a, **k: cast_calls.__setitem__("n", cast_calls["n"] + 1))
    monkeypatch.setattr(
        dlna_svc,
        "get_transport_info",
        lambda device: {"state": "STOPPED", "status": "OK", "speed": "1"},
    )
    dev = dlna_svc.DlnaDevice(
        id="oncedev",
        name="Once Box",
        udn="uuid:once",
        location="http://6.6.6.6/d",
        control_url="http://6.6.6.6/c",
        host="6.6.6.6",
    )
    dlna_svc.start_cast_session(
        dev,
        media_id=1,
        mode="once",
        uri="http://lan/m",
        title="T",
        mime="video/mp4",
        media_type="video",
    )
    time.sleep(0.25)
    assert cast_calls["n"] == 0
    dlna_svc.clear_cast_session("oncedev")
