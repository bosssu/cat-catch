"""
DLNA / UPnP MediaRenderer discovery and cast (SetAVTransportURI + Play).

Frontend only shows a list and posts media_id; this module talks to boxes on LAN.
No third-party UPnP dependency — SSDP + SOAP over HTTP.
"""
from __future__ import annotations

import hashlib
import logging
import socket
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import urljoin, urlparse
from xml.sax.saxutils import escape as xml_escape

import httpx

logger = logging.getLogger("lmw.dlna")

SSDP_ADDR = ("239.255.255.250", 1900)
AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"

# Cache last SSDP result until explicit force-refresh (or process restart).
# Soft age is only for API metadata / optional background revalidate — not auto-evict.
_cache_lock = threading.Lock()
_cache_devices: list["DlnaDevice"] = []
_cache_at: float = 0.0  # monotonic time of last completed scan
_cache_scanned: bool = False  # True after at least one scan finished (even if empty)
_scan_lock = threading.Lock()  # single-flight full scans
_warm_started = False


@dataclass
class DlnaDevice:
    id: str
    name: str
    udn: str
    location: str
    control_url: str
    manufacturer: str = ""
    model: str = ""
    host: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


def _device_id(udn: str, control_url: str) -> str:
    raw = (udn or control_url or "").strip().encode("utf-8", errors="ignore")
    return hashlib.sha1(raw).hexdigest()[:16]


def _local_ipv4s() -> list[str]:
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET, socket.SOCK_STREAM):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    # UDP connect trick: pick the interface used toward a public IP (no packets sent)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.insert(0, ip)
        finally:
            s.close()
    except Exception:
        pass
    return ips


def public_base_url_from_request(
    *,
    host_header: str | None,
    scheme: str,
    server_port: int,
) -> str:
    """
    Build an absolute base URL that a TV box on LAN can reach.
    Prefer the Host the client used (phone on LAN); fall back to first LAN IP.
    """
    host = (host_header or "").strip()
    if host:
        h = host.split(",")[0].strip()
        low = h.lower()
        if not low.startswith("127.") and not low.startswith("localhost"):
            return f"{scheme}://{h}".rstrip("/")
    ips = _local_ipv4s()
    if ips:
        return f"{scheme}://{ips[0]}:{int(server_port)}"
    if host:
        return f"{scheme}://{host}".rstrip("/")
    return f"{scheme}://127.0.0.1:{int(server_port)}"


def _ssdp_msearch(st: str, timeout_sec: float, bind_ip: str | None) -> list[str]:
    """Return unique LOCATION URLs from SSDP replies for one ST."""
    mx = max(1, min(3, int(timeout_sec)))
    payload = (
        "M-SEARCH * HTTP/1.1\r\n"
        f"HOST: {SSDP_ADDR[0]}:{SSDP_ADDR[1]}\r\n"
        'MAN: "ssdp:discover"\r\n'
        f"MX: {mx}\r\n"
        f"ST: {st}\r\n"
        "\r\n"
    ).encode("utf-8")
    locations: list[str] = []
    seen: set[str] = set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        except OSError:
            pass
        if bind_ip:
            try:
                sock.bind((bind_ip, 0))
                try:
                    sock.setsockopt(
                        socket.IPPROTO_IP,
                        socket.IP_MULTICAST_IF,
                        socket.inet_aton(bind_ip),
                    )
                except OSError:
                    pass
            except OSError:
                sock.bind(("", 0))
        else:
            sock.bind(("", 0))
        sock.settimeout(0.35)
        deadline = time.monotonic() + timeout_sec
        try:
            sock.sendto(payload, SSDP_ADDR)
        except OSError as e:
            logger.debug("ssdp send failed bind=%s: %s", bind_ip, e)
            return []
        while time.monotonic() < deadline:
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            text = data.decode("utf-8", errors="replace")
            loc = None
            for line in text.split("\r\n"):
                if line.lower().startswith("location:"):
                    loc = line.split(":", 1)[1].strip()
                    break
            if not loc:
                continue
            key = loc.strip()
            if key in seen:
                continue
            seen.add(key)
            locations.append(key)
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return locations


def _strip_ns(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _find_child_text(el: ET.Element, names: set[str]) -> str:
    for c in el.iter():
        if _strip_ns(c.tag) in names and (c.text or "").strip():
            return (c.text or "").strip()
    return ""


def _parse_device_description(xml_text: str, location: str) -> DlnaDevice | None:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return None

    friendly = ""
    manufacturer = ""
    model = ""
    udn = ""
    control_url_rel = ""

    # Prefer the device that owns AVTransport (nested device trees).
    for dev in root.iter():
        if _strip_ns(dev.tag) != "device":
            continue
        has_av = False
        for svc in dev.iter():
            if _strip_ns(svc.tag) != "service":
                continue
            stype = ""
            curl = ""
            for c in list(svc):
                n = _strip_ns(c.tag)
                if n == "serviceType":
                    stype = (c.text or "").strip()
                elif n == "controlURL":
                    curl = (c.text or "").strip()
            if "AVTransport" in stype and curl:
                has_av = True
                control_url_rel = curl
                break
        if not has_av:
            continue
        friendly = _find_child_text(dev, {"friendlyName"}) or friendly
        manufacturer = _find_child_text(dev, {"manufacturer"}) or manufacturer
        model = _find_child_text(dev, {"modelName", "modelNumber"}) or model
        udn = _find_child_text(dev, {"UDN"}) or udn
        break

    if not control_url_rel:
        # Fallback: any AVTransport in document
        for svc in root.iter():
            if _strip_ns(svc.tag) != "service":
                continue
            stype = ""
            curl = ""
            for c in list(svc):
                n = _strip_ns(c.tag)
                if n == "serviceType":
                    stype = (c.text or "").strip()
                elif n == "controlURL":
                    curl = (c.text or "").strip()
            if "AVTransport" in stype and curl:
                control_url_rel = curl
                break
        if not friendly:
            friendly = _find_child_text(root, {"friendlyName"})
        if not udn:
            udn = _find_child_text(root, {"UDN"})
        if not manufacturer:
            manufacturer = _find_child_text(root, {"manufacturer"})
        if not model:
            model = _find_child_text(root, {"modelName", "modelNumber"})

    if not control_url_rel:
        return None

    control_url = urljoin(location, control_url_rel)
    host = urlparse(location).hostname or ""
    name = friendly or model or host or "DLNA device"
    did = _device_id(udn or control_url, control_url)
    return DlnaDevice(
        id=did,
        name=name,
        udn=udn,
        location=location,
        control_url=control_url,
        manufacturer=manufacturer,
        model=model,
        host=host,
    )


def _fetch_device(location: str, timeout: float = 3.0) -> DlnaDevice | None:
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            r = client.get(location, headers={"User-Agent": "LocalMediaWeb-DLNA/1.0"})
            if r.status_code >= 400:
                return None
            return _parse_device_description(r.text, location)
    except Exception as e:
        logger.debug("device desc failed %s: %s", location, e)
        return None


def cache_age_sec() -> float | None:
    with _cache_lock:
        if not _cache_scanned or _cache_at <= 0:
            return None
        return max(0.0, time.monotonic() - _cache_at)


def has_scan_cache() -> bool:
    with _cache_lock:
        return bool(_cache_scanned)


def discover_devices(
    timeout_sec: float = 2.5,
    *,
    force: bool = False,
) -> list[DlnaDevice]:
    """
    SSDP discover MediaRenderer / AVTransport devices on the LAN.

    - force=False: return last scan instantly if any scan has completed
      (including empty result). Only the first call (or after clear_cache) waits.
    - force=True: full rescan (refresh button / play miss).
    """
    global _cache_devices, _cache_at, _cache_scanned

    if not force:
        with _cache_lock:
            if _cache_scanned:
                return list(_cache_devices)

    # Single-flight: concurrent force/first scans share one SSDP pass.
    with _scan_lock:
        if not force:
            with _cache_lock:
                if _cache_scanned:
                    return list(_cache_devices)

        locations: list[str] = []
        seen_loc: set[str] = set()
        bind_ips = _local_ipv4s() or [None]
        # Prefer targeted ST first; skip ssdp:all unless nothing found (faster).
        sts_primary = (AV_TRANSPORT, MEDIA_RENDERER)
        per = max(1.0, min(2.5, float(timeout_sec) / max(1, len(bind_ips))))

        for bind in bind_ips:
            for st in sts_primary:
                for loc in _ssdp_msearch(st, per, bind):
                    if loc not in seen_loc:
                        seen_loc.add(loc)
                        locations.append(loc)

        if not locations:
            # Fallback broader search once (still within same force/first scan).
            for bind in bind_ips:
                for loc in _ssdp_msearch("ssdp:all", per, bind):
                    if loc not in seen_loc:
                        seen_loc.add(loc)
                        locations.append(loc)

        devices: list[DlnaDevice] = []
        seen_id: set[str] = set()
        for loc in locations:
            dev = _fetch_device(loc)
            if not dev:
                continue
            if dev.id in seen_id:
                continue
            if not dev.control_url:
                continue
            seen_id.add(dev.id)
            devices.append(dev)

        devices.sort(key=lambda d: (d.name or "").lower())
        with _cache_lock:
            _cache_devices = list(devices)
            _cache_at = time.monotonic()
            _cache_scanned = True
        logger.info(
            "dlna discover: %d device(s) from %d location(s) force=%s",
            len(devices),
            len(locations),
            force,
        )
        return list(devices)


def list_devices(
    timeout_sec: float = 2.5,
    *,
    force: bool = False,
) -> dict[str, Any]:
    """Discover or serve cache; include cache metadata for the API/UI."""
    served_from_cache = (not force) and has_scan_cache()
    devices = discover_devices(timeout_sec=timeout_sec, force=force)
    age = cache_age_sec()
    return {
        "items": [d.to_dict() for d in devices],
        "count": len(devices),
        "cached": bool(served_from_cache),
        "age_sec": round(age, 1) if age is not None else None,
    }


def get_cached_device(device_id: str) -> DlnaDevice | None:
    with _cache_lock:
        for d in _cache_devices:
            if d.id == device_id:
                return d
    return None


def find_device(device_id: str, *, rescan: bool = True) -> DlnaDevice | None:
    d = get_cached_device(device_id)
    if d:
        return d
    if not rescan:
        return None
    for d in discover_devices(force=True):
        if d.id == device_id:
            return d
    return None


def warm_cache_background(timeout_sec: float = 2.5, delay_sec: float = 1.5) -> None:
    """Fire-and-forget first scan so the first UI open is often instant."""
    global _warm_started
    with _cache_lock:
        if _warm_started or _cache_scanned:
            return
        _warm_started = True

    def _run() -> None:
        try:
            if delay_sec > 0:
                time.sleep(delay_sec)
            if has_scan_cache():
                return
            discover_devices(timeout_sec=timeout_sec, force=False)
        except Exception:
            logger.exception("dlna warm scan failed")

    threading.Thread(target=_run, name="lmw-dlna-warm", daemon=True).start()


def build_didl_lite(
    *,
    uri: str,
    title: str,
    mime: str,
    media_type: str = "video",
) -> str:
    """Minimal DIDL-Lite item metadata for SetAVTransportURI."""
    mime = (mime or "video/mp4").split(";")[0].strip() or "video/mp4"
    if media_type == "audio" or mime.startswith("audio/"):
        upnp_class = "object.item.audioItem.musicTrack"
        proto = f"http-get:*:{mime}:*"
    elif media_type == "image" or mime.startswith("image/"):
        upnp_class = "object.item.imageItem.photo"
        proto = f"http-get:*:{mime}:*"
    else:
        upnp_class = "object.item.videoItem"
        proto = f"http-get:*:{mime}:*"

    t = xml_escape(title or "LocalMedia")
    u = xml_escape(uri)
    # Nested DIDL is often passed as XML-escaped string inside SOAP.
    didl = (
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        '<item id="0" parentID="-1" restricted="1">'
        f"<dc:title>{t}</dc:title>"
        f"<upnp:class>{upnp_class}</upnp:class>"
        f'<res protocolInfo="{proto}">{u}</res>'
        "</item></DIDL-Lite>"
    )
    return didl


def _soap_envelope(action: str, service_type: str, body_inner: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        f"<s:Body>"
        f'<u:{action} xmlns:u="{service_type}">'
        f"{body_inner}"
        f"</u:{action}>"
        f"</s:Body></s:Envelope>"
    )


def _soap_post(control_url: str, action: str, body_inner: str, timeout: float = 8.0) -> str:
    envelope = _soap_envelope(action, AV_TRANSPORT, body_inner)
    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": f'"{AV_TRANSPORT}#{action}"',
        "User-Agent": "LocalMediaWeb-DLNA/1.0",
    }
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        r = client.post(control_url, content=envelope.encode("utf-8"), headers=headers)
        if r.status_code >= 400:
            snippet = (r.text or "")[:400]
            raise RuntimeError(f"SOAP {action} HTTP {r.status_code}: {snippet}")
        return r.text or ""


def _xml_local(tag: str) -> str:
    if not tag:
        return ""
    if tag[0] == "{":
        return tag.rsplit("}", 1)[-1]
    if ":" in tag:
        return tag.split(":", 1)[-1]
    return tag


def _soap_first_text(xml_text: str, local_name: str) -> str:
    """First element text matching local name (namespace-agnostic)."""
    if not xml_text or not local_name:
        return ""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return ""
    want = local_name.lower()
    for el in root.iter():
        if _xml_local(el.tag).lower() == want:
            return (el.text or "").strip()
    return ""


def rel_time_to_seconds(value: str | None) -> float | None:
    """
    Parse UPnP REL_TIME / ABS_TIME / TrackDuration (H+:MM:SS[.F]) to seconds.
    Returns None for empty / NOT_IMPLEMENTED / unparsable.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    up = s.upper()
    if up in ("NOT_IMPLEMENTED", "N/A"):
        return None
    # Drop fractional seconds
    if "." in s:
        s = s.split(".", 1)[0]
    parts = s.split(":")
    if len(parts) != 3:
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
        sec = int(parts[2])
    except ValueError:
        return None
    if m < 0 or m > 59 or sec < 0 or sec > 59 or h < 0:
        return None
    return float(h * 3600 + m * 60 + sec)


def get_transport_info(device: DlnaDevice) -> dict[str, str]:
    """AVTransport GetTransportInfo → TransportState / status / speed."""
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    body = "<InstanceID>0</InstanceID>"
    text = _soap_post(device.control_url, "GetTransportInfo", body, timeout=5.0)
    return {
        "state": _soap_first_text(text, "TransportState"),
        "status": _soap_first_text(text, "CurrentTransportStatus"),
        "speed": _soap_first_text(text, "CurrentSpeed"),
    }


def get_position_info(device: DlnaDevice) -> dict[str, Any]:
    """AVTransport GetPositionInfo → times + TrackURI."""
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    body = "<InstanceID>0</InstanceID>"
    text = _soap_post(device.control_url, "GetPositionInfo", body, timeout=5.0)
    rel = _soap_first_text(text, "RelTime")
    duration = _soap_first_text(text, "TrackDuration")
    return {
        "rel_time": rel,
        "track_duration": duration,
        "track_uri": _soap_first_text(text, "TrackURI"),
        "rel_sec": rel_time_to_seconds(rel),
        "duration_sec": rel_time_to_seconds(duration),
    }


def cast_uri(
    device: DlnaDevice,
    *,
    uri: str,
    title: str = "LocalMedia",
    mime: str = "video/mp4",
    media_type: str = "video",
) -> None:
    """Push a playable HTTP URI to the renderer and start playback."""
    if not uri:
        raise ValueError("empty uri")
    didl = build_didl_lite(uri=uri, title=title, mime=mime, media_type=media_type)
    # Many boxes want CurrentURIMetaData XML-escaped as a string value.
    meta_escaped = xml_escape(didl)
    set_body = (
        "<InstanceID>0</InstanceID>"
        f"<CurrentURI>{xml_escape(uri)}</CurrentURI>"
        f"<CurrentURIMetaData>{meta_escaped}</CurrentURIMetaData>"
    )
    try:
        _soap_post(device.control_url, "SetAVTransportURI", set_body)
    except RuntimeError as e:
        # Retry without metadata (some cheap boxes choke on DIDL).
        logger.warning("SetAVTransportURI with meta failed, retry plain: %s", e)
        set_body_plain = (
            "<InstanceID>0</InstanceID>"
            f"<CurrentURI>{xml_escape(uri)}</CurrentURI>"
            "<CurrentURIMetaData></CurrentURIMetaData>"
        )
        _soap_post(device.control_url, "SetAVTransportURI", set_body_plain)

    play_body = "<InstanceID>0</InstanceID><Speed>1</Speed>"
    try:
        _soap_post(device.control_url, "Play", play_body)
    except RuntimeError as e:
        # Some devices auto-play after SetAVTransportURI.
        logger.warning("Play failed (may still auto-play): %s", e)


def seconds_to_rel_time(seconds: float) -> str:
    """
    Format seconds as UPnP AVTransport REL_TIME / ABS_TIME target:
    H+:MM:SS (no fractions — widest box compatibility).
    """
    if seconds is None or seconds != seconds:  # NaN
        raise ValueError("invalid position")
    t = max(0.0, float(seconds))
    # Cap extreme values to avoid broken SOAP strings
    if t > 99 * 3600 + 59 * 60 + 59:
        t = 99 * 3600 + 59 * 60 + 59
    total = int(round(t))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f"{h}:{m:02d}:{s:02d}"


def seek_position(device: DlnaDevice, position_sec: float) -> str:
    """
    Seek current AVTransport media on the renderer (REL_TIME).
    Returns the REL_TIME string that was sent.
    """
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    target = seconds_to_rel_time(position_sec)
    body = (
        "<InstanceID>0</InstanceID>"
        "<Unit>REL_TIME</Unit>"
        f"<Target>{xml_escape(target)}</Target>"
    )
    try:
        _soap_post(device.control_url, "Seek", body, timeout=6.0)
    except RuntimeError as e:
        # A few boxes only accept ABS_TIME for the same clock format.
        logger.warning("Seek REL_TIME failed, retry ABS_TIME: %s", e)
        body_abs = (
            "<InstanceID>0</InstanceID>"
            "<Unit>ABS_TIME</Unit>"
            f"<Target>{xml_escape(target)}</Target>"
        )
        _soap_post(device.control_url, "Seek", body_abs, timeout=6.0)
    return target


def pause_device(device: DlnaDevice) -> None:
    """Pause current AVTransport playback on the renderer."""
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    body = "<InstanceID>0</InstanceID>"
    _soap_post(device.control_url, "Pause", body, timeout=6.0)


def play_device(device: DlnaDevice, speed: str = "1") -> None:
    """Resume / start Play on the renderer (does not change URI)."""
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    spd = (speed or "1").strip() or "1"
    body = f"<InstanceID>0</InstanceID><Speed>{xml_escape(spd)}</Speed>"
    _soap_post(device.control_url, "Play", body, timeout=6.0)


def stop_device(device: DlnaDevice) -> None:
    """Stop current AVTransport session (end cast on most boxes)."""
    if not device or not device.control_url:
        raise ValueError("device has no control_url")
    body = "<InstanceID>0</InstanceID>"
    _soap_post(device.control_url, "Stop", body, timeout=6.0)


def resolve_device(device_id: str) -> DlnaDevice | None:
    """Cache first, one force rescan if missing."""
    d = find_device(device_id, rescan=False)
    if d:
        return d
    return find_device(device_id, rescan=True)


def clear_cache() -> None:
    global _cache_devices, _cache_at, _cache_scanned, _warm_started
    with _cache_lock:
        _cache_devices = []
        _cache_at = 0.0
        _cache_scanned = False
        _warm_started = False


# ---------------------------------------------------------------------------
# Cast session: server-side once | loop (no TV playlist / no auto-next).
# Loop polls GetTransportInfo / GetPositionInfo and re-cast_uri same item.
# ---------------------------------------------------------------------------

PLAY_MODES = frozenset({"once", "loop"})
_LOOP_POLL_SEC = 2.5
_LOOP_GRACE_SEC = 5.0
_LOOP_NEAR_END_SEC = 2.0

_session_lock = threading.Lock()
# device_id -> CastSession
_cast_sessions: dict[str, "CastSession"] = {}
_session_seq = 0


@dataclass
class CastSession:
    device_id: str
    media_id: int
    mode: str  # once | loop
    uri: str
    title: str
    mime: str
    media_type: str
    device: DlnaDevice
    gen: int
    user_paused: bool = False
    grace_until: float = 0.0  # monotonic: ignore "ended" until
    active: bool = True

    def to_public(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "media_id": self.media_id,
            "mode": self.mode,
            "title": self.title,
            "user_paused": self.user_paused,
            "active": self.active,
        }


def normalize_play_mode(mode: str | None) -> str:
    m = (mode or "once").strip().lower()
    if m not in PLAY_MODES:
        return "once"
    return m


def get_cast_session(device_id: str | None) -> CastSession | None:
    if not device_id:
        return None
    with _session_lock:
        s = _cast_sessions.get(str(device_id))
        if s and s.active:
            return s
        return None


def clear_cast_session(device_id: str | None = None) -> None:
    """Stop loop watcher for one device, or all if device_id is None."""
    with _session_lock:
        if device_id is None:
            for s in _cast_sessions.values():
                s.active = False
                s.gen += 1
            _cast_sessions.clear()
            return
        did = str(device_id)
        s = _cast_sessions.pop(did, None)
        if s:
            s.active = False
            s.gen += 1


def set_cast_session_paused(device_id: str, paused: bool) -> None:
    with _session_lock:
        s = _cast_sessions.get(str(device_id))
        if not s or not s.active:
            return
        s.user_paused = bool(paused)
        if not paused:
            s.grace_until = time.monotonic() + _LOOP_GRACE_SEC


def touch_cast_session_grace(device_id: str, sec: float | None = None) -> None:
    """After seek / re-cast: avoid treating STOPPED as natural end."""
    with _session_lock:
        s = _cast_sessions.get(str(device_id))
        if not s or not s.active:
            return
        s.grace_until = time.monotonic() + (
            float(sec) if sec is not None else _LOOP_GRACE_SEC
        )


def start_cast_session(
    device: DlnaDevice,
    *,
    media_id: int,
    mode: str,
    uri: str,
    title: str,
    mime: str,
    media_type: str,
) -> CastSession:
    """
    Register cast session after a successful SetAVTransportURI+Play.
    mode=loop starts a background poller that re-pushes the same URI on end.
    mode=once only stores metadata (no poller).
    """
    global _session_seq
    mode_n = normalize_play_mode(mode)
    if not device or not device.id:
        raise ValueError("device required")
    did = str(device.id)
    with _session_lock:
        _session_seq += 1
        gen = _session_seq
        old = _cast_sessions.get(did)
        if old:
            old.active = False
            old.gen += 1
        sess = CastSession(
            device_id=did,
            media_id=int(media_id),
            mode=mode_n,
            uri=uri,
            title=title or "",
            mime=mime or "video/mp4",
            media_type=media_type or "video",
            device=device,
            gen=gen,
            user_paused=False,
            grace_until=time.monotonic() + _LOOP_GRACE_SEC,
            active=True,
        )
        _cast_sessions[did] = sess

    if mode_n == "loop":
        t = threading.Thread(
            target=_loop_watch_device,
            args=(did, gen),
            name=f"lmw-dlna-loop-{did[:8]}",
            daemon=True,
        )
        t.start()
    return sess


def _session_still(device_id: str, gen: int) -> CastSession | None:
    with _session_lock:
        s = _cast_sessions.get(device_id)
        if not s or not s.active or s.gen != gen or s.mode != "loop":
            return None
        return s


def _is_natural_end(device: DlnaDevice) -> bool:
    """
    Best-effort: TransportState STOPPED/NO_MEDIA, or position at track end.
    Does not treat PAUSED_PLAYBACK as end.
    """
    state = ""
    try:
        info = get_transport_info(device)
        state = (info.get("state") or "").strip().upper()
    except Exception as e:
        logger.debug("GetTransportInfo failed: %s", e)

    if state in ("PAUSED_PLAYBACK", "PAUSED", "TRANSITIONING"):
        return False
    if state in ("STOPPED", "NO_MEDIA_PRESENT"):
        return True

    try:
        pos = get_position_info(device)
    except Exception as e:
        logger.debug("GetPositionInfo failed: %s", e)
        return False

    rel = pos.get("rel_sec")
    dur = pos.get("duration_sec")
    if rel is None or dur is None or dur <= 0:
        return False
    # Some boxes freeze on last frame still reporting PLAYING
    if rel >= max(0.0, dur - _LOOP_NEAR_END_SEC):
        return True
    return False


def _loop_watch_device(device_id: str, gen: int) -> None:
    logger.info("dlna loop watcher start device=%s gen=%s", device_id, gen)
    while True:
        time.sleep(_LOOP_POLL_SEC)
        sess = _session_still(device_id, gen)
        if not sess:
            logger.info("dlna loop watcher exit device=%s gen=%s", device_id, gen)
            return
        if sess.user_paused:
            continue
        if time.monotonic() < sess.grace_until:
            continue
        try:
            ended = _is_natural_end(sess.device)
        except Exception:
            logger.exception("dlna loop poll error device=%s", device_id)
            continue
        if not ended:
            continue
        # Re-check session before re-cast
        sess = _session_still(device_id, gen)
        if not sess or sess.user_paused:
            continue
        logger.info(
            "dlna loop re-cast device=%s media_id=%s",
            device_id,
            sess.media_id,
        )
        try:
            cast_uri(
                sess.device,
                uri=sess.uri,
                title=sess.title,
                mime=sess.mime,
                media_type=sess.media_type,
            )
            with _session_lock:
                s2 = _cast_sessions.get(device_id)
                if s2 and s2.gen == gen and s2.active:
                    s2.grace_until = time.monotonic() + _LOOP_GRACE_SEC
                    s2.user_paused = False
        except Exception:
            logger.exception("dlna loop re-cast failed device=%s", device_id)
            # Keep watching; user may fix network or stop later
            with _session_lock:
                s2 = _cast_sessions.get(device_id)
                if s2 and s2.gen == gen and s2.active:
                    s2.grace_until = time.monotonic() + _LOOP_GRACE_SEC


def clear_sessions_for_tests() -> None:
    """Test helper: drop all cast sessions."""
    clear_cast_session(None)
