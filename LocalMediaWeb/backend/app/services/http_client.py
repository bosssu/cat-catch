"""Shared httpx client modes: explicit proxy, env proxy, direct, local probe."""

from __future__ import annotations

import logging
import os
import socket
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import urlparse

import httpx

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Clash / v2rayN / Qv2ray common local HTTP ports
_COMMON_LOCAL_PROXY_PORTS = (7897, 7890, 10809, 10808, 1080, 20171, 6152)


@dataclass(frozen=True)
class HttpMode:
    name: str
    trust_env: bool
    proxy: str | None = None  # e.g. http://127.0.0.1:7897
    verify: bool = True

    def client_kwargs(self, settings: Settings, *, timeout: httpx.Timeout | float | None = None) -> dict[str, Any]:
        if timeout is None:
            timeout = httpx.Timeout(
                settings.request_timeout_sec,
                connect=min(30.0, float(settings.request_timeout_sec)),
            )
        # Keepalive + Windows Proactor: remote/proxy RST often surfaces as
        # ConnectionResetError in _call_connection_lost (noise). Prefer short/no keepalive.
        limits = httpx.Limits(
            max_connections=32,
            max_keepalive_connections=0,
            keepalive_expiry=0,
        )
        kw: dict[str, Any] = {
            "timeout": timeout,
            "headers": {"User-Agent": settings.user_agent},
            "follow_redirects": True,
            "trust_env": self.trust_env,
            "verify": self.verify,
            "limits": limits,
        }
        if self.proxy:
            # Explicit proxy: do not also pull env (avoids double/wrong proxy)
            kw["proxy"] = self.proxy
            kw["trust_env"] = False
        return kw


def _normalize_proxy(url: str | None) -> str | None:
    if not url:
        return None
    u = str(url).strip()
    if not u:
        return None
    if "://" not in u:
        u = "http://" + u
    return u


def _env_proxy() -> str | None:
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        v = os.environ.get(key)
        if v and v.strip():
            return _normalize_proxy(v)
    return None


def _tcp_open(host: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def probe_local_http_proxies() -> list[str]:
    """Return http://127.0.0.1:PORT for ports that accept TCP right now."""
    found: list[str] = []
    for port in _COMMON_LOCAL_PROXY_PORTS:
        if _tcp_open("127.0.0.1", port):
            found.append(f"http://127.0.0.1:{port}")
    return found


def configured_proxy(settings: Settings | None = None) -> str | None:
    s = settings or get_settings()
    return _normalize_proxy(s.https_proxy or s.http_proxy) or None


def iter_http_modes(settings: Settings | None = None) -> Iterator[HttpMode]:
    """
    Ordered network modes for outbound media downloads.
    Dedupes by (proxy, trust_env, verify).
    After secure modes, re-try proxy modes with verify=False (MITM/local cert issues).
    """
    s = settings or get_settings()
    seen: set[tuple[str | None, bool, bool]] = set()
    insecure_queue: list[HttpMode] = []

    def emit(
        name: str,
        *,
        trust_env: bool,
        proxy: str | None = None,
        verify: bool = True,
    ) -> Iterator[HttpMode]:
        te = trust_env if not proxy else False
        key = (proxy, te, verify)
        if key in seen:
            return
        seen.add(key)
        mode = HttpMode(name=name, trust_env=te, proxy=proxy, verify=verify)
        yield mode
        # queue insecure twin for proxy modes only
        if verify and proxy:
            insecure_queue.append(
                HttpMode(name=f"{name}+insecure", trust_env=False, proxy=proxy, verify=False)
            )

    # 1) Explicit config (always first if set)
    cfg = configured_proxy(s)
    if cfg:
        yield from emit(f"config:{cfg}", trust_env=False, proxy=cfg)

    # 2) Environment proxy via trust_env or explicit env URL
    env_p = _env_proxy()
    if env_p:
        yield from emit(f"env:{env_p}", trust_env=False, proxy=env_p)
    if s.http_trust_env:
        yield from emit("trust_env", trust_env=True, proxy=None)

    # 3) Direct (no proxy)
    yield from emit("direct", trust_env=False, proxy=None)

    # 4) Auto-probe local clients (Clash etc.) when enabled
    if s.http_proxy_auto_probe:
        for p in probe_local_http_proxies():
            yield from emit(f"probe:{p}", trust_env=False, proxy=p)

    # 5) Same proxies without TLS verify (some Clash MITM / broken store setups)
    for mode in insecure_queue:
        key = (mode.proxy, mode.trust_env, mode.verify)
        if key in seen:
            continue
        seen.add(key)
        yield mode


# Never send LAN / loopback through Clash — breaks phone→PC and local API self-calls
DEFAULT_NO_PROXY = (
    "localhost,127.0.0.1,::1,"
    "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,"
    "*.local"
)


def apply_proxy_env(proxy: str | None, env: dict[str, str] | None = None) -> dict[str, str]:
    """Mutate/return env with HTTP(S)_PROXY and a safe NO_PROXY for LAN."""
    out = dict(env if env is not None else os.environ)
    if proxy:
        out["HTTP_PROXY"] = proxy
        out["HTTPS_PROXY"] = proxy
        out["http_proxy"] = proxy
        out["https_proxy"] = proxy
    # Always ensure LAN is excluded even if only partial proxy was set earlier
    existing = (out.get("NO_PROXY") or out.get("no_proxy") or "").strip()
    parts = [p.strip() for p in (existing.split(",") if existing else []) if p.strip()]
    for p in DEFAULT_NO_PROXY.split(","):
        if p not in parts:
            parts.append(p)
    no = ",".join(parts)
    out["NO_PROXY"] = no
    out["no_proxy"] = no
    return out


def proxy_env_for_subprocess(settings: Settings | None = None) -> dict[str, str]:
    """Env vars so ffmpeg/curl can use the same proxy preference."""
    s = settings or get_settings()
    proxy = configured_proxy(s) or _env_proxy()
    if not proxy and s.http_proxy_auto_probe:
        probed = probe_local_http_proxies()
        proxy = probed[0] if probed else None
    return apply_proxy_env(proxy)


def describe_network_setup(settings: Settings | None = None) -> str:
    s = settings or get_settings()
    modes = list(iter_http_modes(s))
    return " | ".join(m.name for m in modes)


def host_from_url(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""
