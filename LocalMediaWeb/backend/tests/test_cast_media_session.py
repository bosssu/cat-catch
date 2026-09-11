"""Lock-screen Media Session wiring for DLNA cast (source contract + node unit)."""
from __future__ import annotations

import base64
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend" / "public"
APP_JS = FRONTEND / "assets" / "app.js"
MS_JS = FRONTEND / "assets" / "cast-media-session.js"
INDEX = FRONTEND / "index.html"
NODE_TEST = Path(__file__).resolve().parent / "cast_media_session_node_test.js"


def test_helper_file_and_index_load_order():
    assert MS_JS.is_file()
    html = INDEX.read_text(encoding="utf-8")
    app = html.find("cast-media-session.js")
    body = html.find("app.js")
    assert app != -1 and body != -1
    assert app < body, "helper must load before app.js"
    assert "v=20260824castms1" in html


def test_app_js_wires_media_session():
    src = APP_JS.read_text(encoding="utf-8")
    for needle in (
        "lmwCastMediaSession",
        "syncCastMediaSession",
        "releaseCastMediaSession",
        "ensureCastSilentAudio",
        "skipCastByDelta",
        "previoustrack",
        "nexttrack",
        "bindCastMediaSessionHandlers",
    ):
        assert needle in src, needle
    # Volume stays on the in-page slider, not Media Session
    assert 'setActionHandler("volume"' not in src
    assert "volumechange" not in src.split("bindCastMediaSessionHandlers")[1][:2500]
    # Skip uses user-swipe path so TV auto-cast runs
    assert "fromUser: true" in src
    assert "activateFeedSlide(slide, { fromUser: true, force: true })" in src
    # Session clear unbinds
    assert "releaseCastMediaSession()" in src
    assert "updateCastBar" in src


def test_silent_wav_is_riff():
    text = MS_JS.read_text(encoding="utf-8")
    assert "SILENT_WAV" in text
    marker = "data:audio/wav;base64,"
    assert marker in text
    start = text.index(marker) + len(marker)
    end = start
    while end < len(text) and text[end] not in "\"'":
        end += 1
    raw = base64.b64decode(text[start:end])
    assert raw[:4] == b"RIFF"
    assert raw[8:12] == b"WAVE"


def test_helper_has_no_volume_action():
    text = MS_JS.read_text(encoding="utf-8")
    assert '"play"' in text and '"pause"' in text
    assert "previoustrack" in text and "nexttrack" in text
    assert "volumechange" not in text
    # ACTIONS list should not include volume
    assert "ACTIONS = [" in text
    chunk = text.split("ACTIONS = [", 1)[1].split("]", 1)[0]
    assert "volume" not in chunk.lower()


def test_node_unit_suite():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    r = subprocess.run(
        [node, str(NODE_TEST)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert r.returncode == 0, r.stdout + "\n" + r.stderr
    assert "ok cast-media-session" in r.stdout


def test_main_serves_assets_dir():
    main = (ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")
    assert "frontend" in main and "public" in main
    assert (FRONTEND / "assets" / "cast-media-session.js").is_file()
