from __future__ import annotations

from pathlib import Path

import yaml

from app.core.config import AppConfig, EXAMPLE_CONFIG_PATH, _DEFAULTS, _deep_merge


def test_deep_merge_nested():
    base = {"a": 1, "b": {"x": 1, "y": 2}, "c": [1]}
    overlay = {"b": {"y": 9, "z": 3}, "c": [2], "d": 4}
    out = _deep_merge(base, overlay)
    assert out["a"] == 1
    assert out["b"]["x"] == 1
    assert out["b"]["y"] == 9
    assert out["b"]["z"] == 3
    assert out["c"] == [2]
    assert out["d"] == 4
    # base not mutated
    assert base["b"]["y"] == 2


def test_load_example_deep_merge(tmp_path: Path):
    """Loading a partial yaml merges with defaults (example shape)."""
    partial = tmp_path / "config.yaml"
    partial.write_text(
        yaml.safe_dump(
            {
                "lmw": {"base_url": "http://localhost:9000"},
                "capture": {"min_edge_px": 333},
            },
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    cfg = AppConfig.load(partial)
    assert cfg.get("lmw", "base_url") == "http://localhost:9000"
    # token from defaults when not in file
    assert cfg.get("lmw", "token") == _DEFAULTS["lmw"]["token"]
    assert cfg.get("capture", "min_edge_px") == 333
    # other capture keys preserved from defaults
    assert cfg.get("capture", "skip_avatar_like") == _DEFAULTS["capture"]["skip_avatar_like"]
    assert cfg.get("ui", "one_click_when_single") is False


def test_load_from_example_file_if_present():
    if not EXAMPLE_CONFIG_PATH.exists():
        return
    raw = yaml.safe_load(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8")) or {}
    merged = _deep_merge(_DEFAULTS, raw)
    assert "lmw" in merged
    assert "capture" in merged
    assert merged["capture"]["min_edge_px"] == raw.get("capture", {}).get(
        "min_edge_px", _DEFAULTS["capture"]["min_edge_px"]
    )
