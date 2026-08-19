from __future__ import annotations

import json
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

from app.config import load_config, resolve_dir
from app.format import which_deno, which_ffmpeg, which_ffprobe
from app.jobs import JobStore

try:
    import yt_dlp  # type: ignore

    YTDLP_VER = getattr(yt_dlp, "version", None)
    YTDLP_VER = getattr(YTDLP_VER, "__version__", None) or "ok"
except Exception:  # noqa: BLE001
    YTDLP_VER = None


def main() -> None:
    cfg = load_config()
    download_dir = resolve_dir(cfg, "download_dir")
    store = JobStore(cfg, download_dir)
    host, port = cfg["host"], int(cfg["port"])

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[YtDlpBridge] {self.address_string()} {fmt % args}")

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _json(self, code: int, obj: Any) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path in ("/", "/api/health"):
                self._json(
                    200,
                    {
                        "ok": True,
                        "service": "YtDlpBridge",
                        "yt_dlp": YTDLP_VER or shutil.which("yt-dlp") or False,
                        "ffmpeg": which_ffmpeg() or False,
                        "ffprobe": which_ffprobe() or False,
                        "deno": which_deno() or False,
                        "cookies_from_browser": cfg.get("cookies_from_browser") or "",
                        "proxy": cfg.get("proxy") or "",
                        "port": port,
                    },
                )
                return
            if path == "/api/jobs":
                self._json(200, {"jobs": store.list_jobs()})
                return
            if path.startswith("/api/jobs/"):
                job_id = path.rsplit("/", 1)[-1]
                job = store.get(job_id)
                if not job:
                    self._json(404, {"error": "not found"})
                    return
                self._json(200, job)
                return
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path != "/api/jobs":
                self._json(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            url = (body.get("url") or "").strip()
            try:
                job = store.enqueue(
                    url,
                    title=str(body.get("title") or ""),
                    referer=str(body.get("referer") or ""),
                    cookies=str(body.get("cookies") or ""),
                )
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            self._json(202, job)

        def do_DELETE(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path.endswith("/cancel"):
                path = path[: -len("/cancel")]
            if not path.startswith("/api/jobs/"):
                self._json(404, {"error": "not found"})
                return
            job_id = path.rsplit("/", 1)[-1]
            job = store.cancel(job_id)
            if not job:
                self._json(404, {"error": "not found"})
                return
            self._json(200, job)

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[YtDlpBridge] listen http://{host}:{port}  downloads={download_dir}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[YtDlpBridge] stop")
        httpd.shutdown()


if __name__ == "__main__":
    main()
