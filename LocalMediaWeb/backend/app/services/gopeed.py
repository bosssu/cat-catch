"""Optional Gopeed CLI backend for large direct HTTP downloads (PC profile)."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path

from app.core.config import get_settings

logger = logging.getLogger("lmw.gopeed")


def resolve_gopeed_path(explicit: str = "") -> str | None:
    """Return absolute path to gopeed binary, or None if unavailable."""
    if explicit and explicit.strip():
        p = Path(explicit.strip())
        if p.is_file():
            return str(p.resolve())
        which = shutil.which(explicit.strip())
        if which:
            return which
    which = shutil.which("gopeed")
    if which:
        return which
    home = Path.home()
    for cand in (
        home / ".grok" / "bin" / "gopeed.exe",
        home / "go" / "bin" / "gopeed.exe",
        home / "AppData" / "Local" / "gopeed" / "gopeed.exe",
        Path("C:/Users") / os.environ.get("USERNAME", "") / ".grok" / "bin" / "gopeed.exe",
    ):
        if cand.is_file():
            return str(cand.resolve())
    return None


def gopeed_available() -> bool:
    s = get_settings()
    if not getattr(s, "gopeed_enabled", False):
        return False
    return resolve_gopeed_path(getattr(s, "gopeed_path", "") or "") is not None


def _proxy_env(settings) -> dict[str, str]:
    """Env for Gopeed subprocess only (does not mutate server process)."""
    env = os.environ.copy()
    proxy = (getattr(settings, "http_proxy", None) or getattr(settings, "https_proxy", None) or "").strip()
    if proxy:
        env["HTTP_PROXY"] = proxy
        env["HTTPS_PROXY"] = proxy
        env["http_proxy"] = proxy
        env["https_proxy"] = proxy
        env["ALL_PROXY"] = proxy
        env["all_proxy"] = proxy
    return env


def _pick_downloaded_file(dir_path: Path) -> Path | None:
    """Choose the largest non-empty file under dir (Gopeed uses URL basename)."""
    best: Path | None = None
    best_sz = 0
    if not dir_path.is_dir():
        return None
    for p in dir_path.rglob("*"):
        if not p.is_file():
            continue
        # skip temp / partial markers if any
        name = p.name.lower()
        if name.endswith(".tmp") or name.endswith(".part") or name.startswith("."):
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        if sz > best_sz:
            best = p
            best_sz = sz
    return best if best_sz > 0 else None


async def download_with_gopeed(
    url: str,
    dest_dir: Path,
    *,
    expected_size: int = 0,
    job_id: int | None = None,
    is_cancelled=None,
    progress_cb=None,
) -> Path:
    """
    Run gopeed CLI into dest_dir. Returns path to downloaded file.
    Raises RuntimeError on failure (caller should fallback to httpx).
    """
    settings = get_settings()
    binary = resolve_gopeed_path(getattr(settings, "gopeed_path", "") or "")
    if not binary:
        raise RuntimeError("gopeed binary not found")

    dest_dir.mkdir(parents=True, exist_ok=True)
    # isolate this job's files
    for child in list(dest_dir.iterdir()):
        try:
            if child.is_file():
                child.unlink(missing_ok=True)
            elif child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            pass

    connections = max(1, int(getattr(settings, "gopeed_connections", 16) or 16))
    env = _proxy_env(settings)
    cmd = [binary, "-C", str(connections), "-D", str(dest_dir), url]
    logger.info("job %s gopeed: %s", job_id, " ".join(cmd[:4] + ["…"]))

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(dest_dir),
    )

    # Poll for cancel + rough progress (CLI has no structured progress API)
    while True:
        try:
            await asyncio.wait_for(proc.wait(), timeout=0.8)
            break
        except asyncio.TimeoutError:
            if is_cancelled and job_id is not None and is_cancelled(job_id):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
                raise RuntimeError("cancelled")
            if progress_cb and expected_size > 0:
                got = _pick_downloaded_file(dest_dir)
                if got:
                    try:
                        sz = got.stat().st_size
                        await progress_cb(min(99.0, sz / expected_size * 100.0), sz, expected_size)
                    except OSError:
                        pass

    out_b = (await proc.stdout.read()) if proc.stdout else b""
    err_b = (await proc.stderr.read()) if proc.stderr else b""
    text = (out_b + err_b).decode("utf-8", errors="replace")
    low = text.lower()

    if proc.returncode not in (0, None) and "fail" in low:
        raise RuntimeError(f"gopeed exit {proc.returncode}: {text[-800:]}")
    if "fail" in low and "reason" in low:
        raise RuntimeError(f"gopeed reported fail: {text[-800:]}")

    path = _pick_downloaded_file(dest_dir)
    if not path:
        raise RuntimeError(f"gopeed produced no file: {text[-500:] or '(no output)'}")

    sz = path.stat().st_size
    if sz < 1024:
        # likely error page
        raise RuntimeError(f"gopeed file too small ({sz} bytes)")
    if expected_size > 0 and sz < expected_size * 0.5:
        # incomplete vs HEAD size (allow some variance for compression / wrong CL)
        raise RuntimeError(f"gopeed incomplete: got {sz} expected ~{expected_size}")

    if progress_cb:
        await progress_cb(100.0, sz, expected_size or sz)
    return path
