"""Launch uvicorn with explicit host/port (used by start.ps1)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure backend is on path when started from project root
ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
os.environ.setdefault("PYTHONPATH", str(BACKEND))

# Strip process-level proxy so LAN serving never goes through Clash
for k in (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
):
    os.environ.pop(k, None)
os.environ.setdefault(
    "NO_PROXY",
    "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local",
)
os.environ.setdefault("no_proxy", os.environ["NO_PROXY"])


def main() -> None:
    import uvicorn

    from app.core.config import get_settings

    s = get_settings()
    host = (sys.argv[1] if len(sys.argv) > 1 else s.host) or "0.0.0.0"
    if host in ("127.0.0.1", "localhost"):
        host = "0.0.0.0"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else int(s.port)
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        app_dir=str(BACKEND),
        reload=False,
    )


if __name__ == "__main__":
    main()
