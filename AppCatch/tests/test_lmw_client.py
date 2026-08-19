from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import httpx

from app.core.config import AppConfig, _DEFAULTS
from app.lmw.client import LmwClient


def _client(base_url: str = "http://127.0.0.1:8790", token: str = "tok") -> LmwClient:
    data = {
        "lmw": {"base_url": base_url, "token": token},
        "ui": dict(_DEFAULTS["ui"]),
        "capture": dict(_DEFAULTS["capture"]),
        "ingest": dict(_DEFAULTS["ingest"]),
        "extensions": dict(_DEFAULTS["extensions"]),
    }
    return LmwClient(AppConfig(data, path=None))  # type: ignore[arg-type]


def test_health_calls_api():
    client = _client()
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"ok": True, "version": "1"}
    mock_resp.raise_for_status = MagicMock()

    mock_http = MagicMock()
    mock_http.get.return_value = mock_resp
    mock_http.__enter__ = MagicMock(return_value=mock_http)
    mock_http.__exit__ = MagicMock(return_value=False)

    with patch("app.lmw.client.httpx.Client", return_value=mock_http):
        result = client.health()

    assert result == {"ok": True, "version": "1"}
    mock_http.get.assert_called_once_with("http://127.0.0.1:8790/api/health")


def test_upload_form_fields(tmp_path: Path):
    f = tmp_path / "pic.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

    client = _client(token="secret")
    captured: dict = {}

    def fake_post(url, data=None, files=None, headers=None, **kwargs):
        captured["url"] = url
        captured["data"] = dict(data or {})
        captured["files"] = files
        captured["headers"] = headers or {}
        resp = MagicMock()
        resp.json.return_value = {"media_id": 42, "duplicate": False}
        resp.raise_for_status = MagicMock()
        return resp

    mock_http = MagicMock()
    mock_http.post.side_effect = fake_post
    mock_http.__enter__ = MagicMock(return_value=mock_http)
    mock_http.__exit__ = MagicMock(return_value=False)

    with patch("app.lmw.client.httpx.Client", return_value=mock_http):
        result = client.upload(
            f,
            title="My Pic",
            source_url="https://example.com/pic.png",
            media_type="image",
            tags=["t1", "t2"],
            restricted=True,
            use_jasna=False,
            remux=True,
        )

    assert result["media_id"] == 42
    assert captured["url"] == "http://127.0.0.1:8790/api/upload"
    d = captured["data"]
    assert d["title"] == "My Pic"
    assert d["source_url"] == "https://example.com/pic.png"
    assert d["media_type"] == "image"
    assert d["remux"] == "1"
    assert d["restricted"] == "1"
    assert d["use_jasna"] == "0"
    assert d["category"] == "default"
    assert json.loads(d["tags"]) == ["t1", "t2"]
    assert "X-LMW-Token" in captured["headers"]
    assert captured["headers"]["Authorization"] == "Bearer secret"
    assert "file" in captured["files"]


def test_upload_missing_file_raises(tmp_path: Path):
    client = _client()
    missing = tmp_path / "nope.jpg"
    try:
        client.upload(missing)
        assert False, "expected FileNotFoundError"
    except FileNotFoundError:
        pass
