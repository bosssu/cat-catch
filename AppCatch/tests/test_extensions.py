from __future__ import annotations

from pathlib import Path

from app.core.config import AppConfig, ROOT, _DEFAULTS
from app.extensions.loader import ExtensionRegistry


def _cfg() -> AppConfig:
    data = {
        **{k: v for k, v in _DEFAULTS.items()},
        "extensions": {
            "directory": str(ROOT / "extensions"),
            "disabled_ids": [],
            "auto_reload_on_focus": False,
        },
    }
    return AppConfig(data, path=ROOT / "config.yaml")


def test_load_registry_from_real_extensions_dir():
    reg = ExtensionRegistry(_cfg())
    reg.reload()
    ids = {e.id for e in reg.extensions}
    assert "discord.cdn" in ids
    assert "_template" in ids or any(e.is_template for e in reg.extensions)
    assert "builtin.network" in ids


def test_discord_matches_discord_exe():
    reg = ExtensionRegistry(_cfg())
    reg.reload()
    disc = next(e for e in reg.extensions if e.id == "discord.cdn")
    assert disc.enabled is True
    assert disc.matches_process("Discord.exe") is True
    assert disc.matches_process("Discord") is True
    assert disc.matches_process("Chrome.exe") is False


def test_claim_network_url_discord_cdn():
    reg = ExtensionRegistry(_cfg())
    reg.reload()
    url = "https://cdn.discordapp.com/attachments/111/222/cat.png"
    cands = reg.claim_network_url(url, process_name="Discord.exe")
    assert cands, "expected at least one candidate"
    assert any(c.extension_id == "discord.cdn" for c in cands)
    assert cands[0].source_url == url


def test_avatar_url_excluded():
    reg = ExtensionRegistry(_cfg())
    reg.reload()
    url = "https://cdn.discordapp.com/avatars/123/abcdef.png"
    cands = reg.claim_network_url(url, process_name="Discord.exe")
    # avatar excluded by discord.cdn L-A rules; suppress builtin fallback too
    assert cands == []
    assert not any(c.extension_id == "discord.cdn" for c in cands)


def test_template_not_enabled():
    reg = ExtensionRegistry(_cfg())
    reg.reload()
    templates = [e for e in reg.extensions if e.is_template or e.id == "_template" or e.path.name == "_template"]
    assert templates, "expected _template extension entry"
    for t in templates:
        assert t.enabled is False
        assert t.is_template is True
