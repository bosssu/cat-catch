from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from app.core.config import AppConfig, _DEFAULTS
from app.core.grade import CandidateGrade, grade_candidate, session_summary
from app.core.models import MediaCandidate, MediaType, SourceKind, WindowInfo
from app.core.pipeline import CapturePipeline


def _cfg() -> AppConfig:
    data = {
        "ui": dict(_DEFAULTS["ui"]),
        "capture": {**dict(_DEFAULTS["capture"]), "cache_enabled": False},
        "ingest": dict(_DEFAULTS["ingest"]),
        "extensions": dict(_DEFAULTS["extensions"]),
        "lmw": dict(_DEFAULTS["lmw"]),
        "download": dict(_DEFAULTS.get("download") or {"enabled": True, "prefer_ytdlp": True}),
    }
    return AppConfig(data, path=None)  # type: ignore[arg-type]


def test_build_session_merges_extra_and_grades(tmp_path: Path):
    reg = MagicMock()
    reg.collect_for_session.return_value = []
    reg.enabled_for_process.return_value = []
    reg.extensions = []
    pipe = CapturePipeline(
        cfg=_cfg(),
        lmw=MagicMock(),
        registry=reg,
        recent=MagicMock(),
        network_sentry=None,
    )
    # disable folder by empty
    pipe._folder_watch.dirs = []  # type: ignore[attr-defined]

    info = WindowInfo(hwnd=1, pid=42, process_name="Discord.exe", title="x", rect=(0, 0, 1, 1))
    extra = [
        MediaCandidate(
            media_type=MediaType.VIDEO,
            source_kind=SourceKind.NETWORK,
            source_url="https://cdn.discordapp.com/attachments/1/2/v.mp4",
            process_name="clipboard",
        )
    ]
    session = pipe.build_session(info, extra=extra)
    assert any(c.source_url.endswith("v.mp4") for c in session.candidates)
    # process_name rewritten to window
    hit = next(c for c in session.candidates if c.source_url.endswith("v.mp4"))
    assert hit.process_name == "Discord.exe"
    assert hit.pid == 42
    assert hit.meta.get("grade") == CandidateGrade.LINK.value
    sm = session_summary(session.candidates)
    assert sm["link"] >= 1


def test_materialize_local_file(tmp_path: Path):
    reg = MagicMock(extensions=[], collect_for_session=MagicMock(return_value=[]))
    reg.enabled_for_process.return_value = []
    pipe = CapturePipeline(cfg=_cfg(), lmw=MagicMock(), registry=reg, recent=MagicMock())
    f = tmp_path / "a.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    c = MediaCandidate(
        media_type=MediaType.IMAGE,
        source_kind=SourceKind.FILE,
        local_path=str(f),
        title="a.png",
    )
    ok, msg = pipe.materialize(c)
    assert ok
    assert grade_candidate(c) == CandidateGrade.ORIGINAL
