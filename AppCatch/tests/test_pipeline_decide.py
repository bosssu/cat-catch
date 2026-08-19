from __future__ import annotations

from unittest.mock import MagicMock

from app.core.config import AppConfig, _DEFAULTS
from app.core.models import CaptureSession, MediaCandidate, MediaType, SourceKind
from app.core.pipeline import CapturePipeline


def _cfg(**ui) -> AppConfig:
    data = {
        "ui": {**_DEFAULTS["ui"], **ui},
        "capture": dict(_DEFAULTS["capture"]),
        "ingest": dict(_DEFAULTS["ingest"]),
        "extensions": dict(_DEFAULTS["extensions"]),
        "lmw": dict(_DEFAULTS["lmw"]),
    }
    return AppConfig(data, path=None)  # type: ignore[arg-type]


def _session(*candidates: MediaCandidate) -> CaptureSession:
    s = CaptureSession(hwnd=1, pid=1, process_name="App.exe", window_title="t")
    s.candidates = list(candidates)
    return s


def _cand(filtered: bool = False) -> MediaCandidate:
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.NETWORK,
        source_url="https://example.com/a.png",
        width=800,
        height=600,
    )
    c.filtered_out = filtered
    return c


def _pipeline(cfg: AppConfig) -> CapturePipeline:
    return CapturePipeline(
        cfg=cfg,
        lmw=MagicMock(),
        registry=MagicMock(extensions=[]),
        recent=MagicMock(),
    )


def test_decide_zero_visible_screenshot_fallback():
    pipe = _pipeline(_cfg(allow_screenshot_fallback=True))
    # filtered-only counts as zero visible
    s = _session(_cand(filtered=True))
    assert pipe.decide_ui(s) == "screenshot_fallback"


def test_decide_zero_empty():
    pipe = _pipeline(_cfg(allow_screenshot_fallback=False))
    assert pipe.decide_ui(_session()) == "empty"


def test_decide_one_ingest_single():
    pipe = _pipeline(_cfg(one_click_when_single=True, multi_open_grid="always_when_ge_2"))
    assert pipe.decide_ui(_session(_cand())) == "ingest_single"


def test_decide_one_grid_when_one_click_off():
    pipe = _pipeline(_cfg(one_click_when_single=False))
    assert pipe.decide_ui(_session(_cand())) == "grid"


def test_decide_two_grid():
    pipe = _pipeline(_cfg())
    assert pipe.decide_ui(_session(_cand(), _cand())) == "grid"
