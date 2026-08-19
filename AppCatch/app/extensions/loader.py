from __future__ import annotations

import importlib.util
import re
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from app.core.config import AppConfig
from app.core.models import CaptureSession, MediaCandidate, MediaType, SourceKind
from app.extensions import runtime
from app.sources.media_guess import guess_media_type, is_likely_media_url, strip_url_key


@dataclass
class ExtensionInfo:
    id: str
    name: str
    version: str
    path: Path
    enabled: bool
    match_processes: list[str] = field(default_factory=list)
    url_include: list[re.Pattern[str]] = field(default_factory=list)
    url_exclude: list[re.Pattern[str]] = field(default_factory=list)
    suggested_tags: list[str] = field(default_factory=list)
    watch_paths: list[str] = field(default_factory=list)
    is_builtin: bool = False
    is_template: bool = False
    error: str = ""
    plugin: Any = None
    raw_manifest: dict = field(default_factory=dict)

    def matches_process(self, process_name: str) -> bool:
        if not self.match_processes:
            # empty match = generic (always)
            return True
        base = (process_name or "").lower().removesuffix(".exe")
        for p in self.match_processes:
            pb = p.lower().removesuffix(".exe")
            if base == pb or base.startswith(pb):
                return True
        return False

    def claim_url(self, url: str) -> bool:
        """L-A: True if URL matches include rules and not exclude."""
        if not self.url_include and not self.url_exclude:
            return False
        for ex in self.url_exclude:
            if ex.search(url):
                return False
        if not self.url_include:
            return True
        return any(inc.search(url) for inc in self.url_include)

    def include_matches(self, url: str) -> bool:
        """True if include regexes match (or no include list means open include)."""
        if not self.url_include and not self.url_exclude:
            return False
        if not self.url_include:
            return True
        return any(inc.search(url) for inc in self.url_include)

    def exclude_matches(self, url: str) -> bool:
        return any(ex.search(url) for ex in self.url_exclude)


class ExtensionRegistry:
    def __init__(self, cfg: AppConfig):
        self.cfg = cfg
        self.extensions: list[ExtensionInfo] = []

    def reload(self) -> list[ExtensionInfo]:
        self.extensions = []
        # builtins (virtual)
        self.extensions.extend(_builtin_infos())
        ext_dir = self.cfg.extensions_dir()
        ext_dir.mkdir(parents=True, exist_ok=True)
        disabled = set(self.cfg.get("extensions", "disabled_ids", default=[]) or [])
        for child in sorted(ext_dir.iterdir()):
            if not child.is_dir():
                continue
            # skip private dirs; _template is listed but never enabled
            if child.name.startswith(".") or (child.name.startswith("_") and child.name != "_template"):
                continue
            if child.name == "_template":
                info = _load_manifest_dir(child, disabled=True, is_template=True)
                if info:
                    info.enabled = False
                    info.is_template = True
                    self.extensions.append(info)
                continue
            info = _load_manifest_dir(child, disabled=child.name in disabled)
            if info:
                # disabled by config id or folder name
                if info.id in disabled or child.name in disabled:
                    info.enabled = False
                # never treat template-shaped installs as production-active if marked
                if info.is_template:
                    info.enabled = False
                self.extensions.append(info)
        return self.extensions

    def enabled_for_process(self, process_name: str) -> list[ExtensionInfo]:
        return [
            e
            for e in self.extensions
            if e.enabled and not e.is_template and e.matches_process(process_name)
        ]

    def list_active(self) -> list[ExtensionInfo]:
        """Extensions that are enabled and not templates (production list)."""
        return [e for e in self.extensions if e.enabled and not e.is_template]

    def collect_for_session(self, session: CaptureSession) -> list[MediaCandidate]:
        cands: list[MediaCandidate] = []
        for ext in self.enabled_for_process(session.process_name):
            if ext.id not in session.extension_ids:
                session.extension_ids.append(ext.id)
            # L-B collect via runtime (safe_call + stamp extension_id)
            got = runtime.run_collect(ext, session, self.cfg)
            cands.extend(got)
        return cands

    def apply_network_rules_from_manifests(
        self,
        url: str,
        process_name: str = "",
    ) -> list[ExtensionInfo]:
        """
        L-A only: enabled non-template extensions matching process whose
        url_include/exclude claims this URL (excludes pure builtins without rules).
        """
        matching: list[ExtensionInfo] = []
        for ext in self.enabled_for_process(process_name):
            if ext.is_builtin and not ext.url_include and not ext.url_exclude:
                continue
            if ext.claim_url(url):
                matching.append(ext)
        return matching

    def claim_network_url(
        self,
        url: str,
        *,
        pid: int | None = None,
        process_name: str = "",
        mime: str = "",
        bytes_hint: int | None = None,
        headers: dict[str, str] | None = None,
        session: CaptureSession | None = None,
    ) -> list[MediaCandidate]:
        """
        L-A + L-B network claim:
        - For each enabled extension matching process (or generic empty match):
          - If manifest URL rules match → MediaCandidate NETWORK
          - If plugin has on_network_item → also call and merge
        - builtin.network: if nothing claimed but URL looks like media → candidate
        """
        if not url:
            return []

        headers = dict(headers or {})
        cands: list[MediaCandidate] = []
        claimed_by_ext = False
        # Process-specific L-A exclude (e.g. discord /avatars/) suppresses builtin fallback
        explicit_reject = False
        raw = {
            "url": url,
            "source_url": url,
            "pid": pid,
            "process_name": process_name,
            "mime": mime,
            "bytes_hint": bytes_hint,
            "headers": headers,
        }

        for ext in self.enabled_for_process(process_name):
            if ext.is_builtin:
                # builtins handled after disk extensions (except rules-bearing ones)
                if not ext.url_include and not ext.url_exclude and not ext.plugin:
                    continue

            has_rules = bool(ext.url_include or ext.url_exclude)
            la_hit = ext.claim_url(url)
            if has_rules and ext.include_matches(url) and ext.exclude_matches(url):
                explicit_reject = True

            if la_hit:
                claimed_by_ext = True
                cands.append(
                    _network_candidate(
                        url=url,
                        extension_id=ext.id,
                        process_name=process_name,
                        pid=pid,
                        mime=mime,
                        bytes_hint=bytes_hint,
                        headers=headers,
                        suggested_tags=list(ext.suggested_tags),
                    )
                )

            # L-B: on_network_item when L-A hit, or generic plugin with no URL rules
            if ext.plugin and hasattr(ext.plugin, "on_network_item"):
                if la_hit or not has_rules:
                    more = runtime.run_on_network_item(ext, session, raw, self.cfg)
                    if more:
                        claimed_by_ext = True
                        for c in more:
                            if not c.process_name:
                                c.process_name = process_name
                            if c.pid is None:
                                c.pid = pid
                            cands.append(c)

        if not claimed_by_ext and not explicit_reject and is_likely_media_url(url, mime):
            # builtin.network fallback
            cands.append(
                _network_candidate(
                    url=url,
                    extension_id="builtin.network",
                    process_name=process_name,
                    pid=pid,
                    mime=mime,
                    bytes_hint=bytes_hint,
                    headers=headers,
                    suggested_tags=[],
                )
            )

        return cands

    def apply_before_ingest(self, candidate: MediaCandidate) -> MediaCandidate:
        """Run before_ingest on the owning extension if any."""
        if not candidate.extension_id:
            return candidate
        for ext in self.extensions:
            if ext.id == candidate.extension_id and ext.enabled and not ext.is_template:
                return runtime.run_before_ingest(ext, candidate, self.cfg)
        return candidate


def _network_candidate(
    *,
    url: str,
    extension_id: str,
    process_name: str,
    pid: int | None,
    mime: str,
    bytes_hint: int | None,
    headers: dict[str, str],
    suggested_tags: list[str],
) -> MediaCandidate:
    mt = guess_media_type(url, mime)
    meta: dict[str, Any] = {
        "url_key": strip_url_key(url),
    }
    if suggested_tags:
        meta["suggested_tags"] = list(suggested_tags)
    return MediaCandidate(
        media_type=mt,
        source_kind=SourceKind.NETWORK,
        extension_id=extension_id,
        process_name=process_name or "",
        pid=pid,
        source_url=url,
        bytes_hint=bytes_hint,
        mime=mime or None,
        headers=dict(headers or {}),
        meta=meta,
    )


def _compile_list(patterns: list[str] | None) -> list[re.Pattern[str]]:
    out = []
    for p in patterns or []:
        try:
            out.append(re.compile(p, re.I))
        except re.error:
            pass
    return out


def _load_manifest_dir(path: Path, disabled: bool = False, is_template: bool = False) -> ExtensionInfo | None:
    man = path / "manifest.yaml"
    if not man.exists():
        return None
    try:
        raw = yaml.safe_load(man.read_text(encoding="utf-8")) or {}
    except Exception as e:
        return ExtensionInfo(
            id=path.name,
            name=path.name,
            version="0",
            path=path,
            enabled=False,
            error=f"manifest: {e}",
        )
    eid = str(raw.get("id") or path.name)
    # folder named _template or manifest id from template copy still template if path is
    is_template = is_template or path.name == "_template" or bool(raw.get("is_template"))
    match = raw.get("match") or {}
    network = raw.get("network") or {}
    info = ExtensionInfo(
        id=eid,
        name=str(raw.get("name") or eid),
        version=str(raw.get("version") or "0"),
        path=path,
        enabled=bool(raw.get("enabled", True)) and not disabled and not is_template,
        match_processes=list(match.get("process_names") or []),
        url_include=_compile_list(network.get("url_include_regex")),
        url_exclude=_compile_list(network.get("url_exclude_regex")),
        suggested_tags=list(raw.get("suggested_tags") or []),
        watch_paths=list(raw.get("watch_paths") or []),
        is_template=is_template,
        raw_manifest=raw,
    )
    plugin_py = path / "plugin.py"
    # only load plugin for truly enabled extensions (not templates / disabled)
    if plugin_py.exists() and info.enabled:
        try:
            info.plugin = _load_plugin_module(eid, plugin_py)
        except Exception as e:
            info.error = f"plugin: {e}"
            traceback.print_exc()
    return info


def _load_plugin_module(eid: str, path: Path) -> Any:
    mod_name = f"appcatch_ext_{eid.replace('.', '_')}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load plugin")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _builtin_infos() -> list[ExtensionInfo]:
    return [
        ExtensionInfo(
            id="builtin.network",
            name="通用网络媒体",
            version="0.1.0",
            path=Path("."),
            enabled=True,
            is_builtin=True,
        ),
        ExtensionInfo(
            id="builtin.cache",
            name="缓存捞取",
            version="0.1.0",
            path=Path("."),
            enabled=True,
            is_builtin=True,
        ),
        ExtensionInfo(
            id="builtin.screenshot",
            name="截图兜底",
            version="0.1.0",
            path=Path("."),
            enabled=True,
            is_builtin=True,
        ),
    ]
