from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app import __version__
from app.api.routes import public_router, router
from app.services.media_process import IosCodecError
from app.core.config import PROJECT_ROOT, get_settings
from app.core.db import init_db
from app.core.logging_setup import setup_logging
from app.services.download import start_worker
from app.services.jasna import start_jasna_worker

STATIC_DIR = PROJECT_ROOT / "frontend" / "public"
logger = logging.getLogger("lmw")

# High-frequency GET paths: only log failures (status >= 400)
_API_QUIET_GET_PREFIXES = (
    "/api/health",
    "/api/feed",
    "/api/media/",
    "/api/jobs",
    "/api/jasna/",
    "/api/tags",
    "/api/thumb",
)


class NoCacheHtmlMiddleware(BaseHTTPMiddleware):
    """Avoid stale SPA shell / assets after deploys (esp. mobile WebView)."""

    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        path = request.url.path or ""
        if path == "/" or path.endswith(".html"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        elif path.startswith("/assets/"):
            # short cache; query-string versioning (?v=) busts on release
            response.headers.setdefault("Cache-Control", "public, max-age=60, must-revalidate")
        return response


class ApiAccessLogMiddleware(BaseHTTPMiddleware):
    """
    Light API access log: all mutating methods + any 4xx/5xx.
    Skips successful high-frequency feed/media GETs to avoid flooding app.log.
    """

    async def dispatch(self, request: Request, call_next):
        import time

        path = request.url.path or ""
        method = (request.method or "GET").upper()
        if not path.startswith("/api/"):
            return await call_next(request)

        t0 = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            ms = (time.perf_counter() - t0) * 1000
            logging.getLogger("lmw.api").exception(
                "crash %s %s after %.0fms client=%s",
                method,
                path,
                ms,
                (request.client.host if request.client else "-"),
            )
            raise

        status = int(getattr(response, "status_code", 0) or 0)
        ms = (time.perf_counter() - t0) * 1000
        quiet_ok = (
            status < 400
            and path.startswith("/api/feed")
            and method in ("GET", "POST")
        ) or (
            method == "GET"
            and status < 400
            and any(path == p or path.startswith(p) for p in _API_QUIET_GET_PREFIXES)
        )
        if quiet_ok:
            return response

        client = request.client.host if request.client else "-"
        log = logging.getLogger("lmw.api")
        msg = "%s %s -> %s %.0fms client=%s"
        if status >= 500:
            log.error(msg, method, path, status, ms, client)
        elif status >= 400:
            log.warning(msg, method, path, status, ms, client)
        else:
            log.info(msg, method, path, status, ms, client)
        return response


def _install_asyncio_quiet_handler() -> None:
    """
    Windows Proactor: proxy/CDN RST closes sockets; asyncio then logs
    ConnectionResetError in _ProactorBasePipeTransport._call_connection_lost.
    Harmless — swallow only that known noise.
    """
    if sys.platform != "win32":
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    default = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError):
            return
        if isinstance(exc, ConnectionAbortedError):
            return
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (10054, 10053):
            return
        msg = str(context.get("message") or "")
        if "_call_connection_lost" in msg or "ProactorBasePipeTransport" in msg:
            if isinstance(exc, (ConnectionError, OSError)):
                return
        if default:
            default(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    setup_logging(logs_dir=settings.logs_path())
    _install_asyncio_quiet_handler()
    settings.ensure_dirs()
    init_db()
    logger.info(
        "LocalMediaWeb %s starting host=%s port=%s profile=%s medias=%s",
        __version__,
        settings.host,
        settings.port,
        settings.profile,
        settings.medias_path(),
    )
    await start_worker()
    # Jasna is optional; weak 24/7 hosts should keep jasna_enabled=false and use JasnaBridge.
    if bool(getattr(settings, "jasna_enabled", False)):
        await start_jasna_worker()
    else:
        logger.info("jasna worker not started (jasna_enabled=false; use local JasnaBridge)")
    # Warm DLNA device list in background so first cast UI open is usually instant.
    try:
        from app.services.dlna import warm_cache_background

        warm_cache_background(timeout_sec=2.5, delay_sec=1.5)
    except Exception:
        logger.exception("dlna warm schedule failed")
    yield
    logger.info("LocalMediaWeb shutting down")


app = FastAPI(title="LocalMediaWeb", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Starlette: last added runs first. Access log outermost so it sees final status.
app.add_middleware(ApiAccessLogMiddleware)
app.add_middleware(NoCacheHtmlMiddleware)

app.include_router(public_router)
app.include_router(router)


@app.exception_handler(IosCodecError)
async def ios_codec_error_handler(request: Request, exc: IosCodecError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/")
def index():
    index_path = STATIC_DIR / "index.html"
    if index_path.is_file():
        return FileResponse(
            index_path,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )
    return {"message": "LocalMediaWeb API", "docs": "/docs", "health": "/api/health"}


@app.get("/manifest.webmanifest")
def web_manifest():
    path = STATIC_DIR / "manifest.webmanifest"
    if not path.is_file():
        return Response(status_code=404)
    return FileResponse(
        path,
        media_type="application/manifest+json",
        headers={"Cache-Control": "public, max-age=300, must-revalidate"},
    )


if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
    icons_dir = STATIC_DIR / "icons"
    if icons_dir.is_dir():
        app.mount("/icons", StaticFiles(directory=icons_dir), name="icons")


def run() -> None:
    import uvicorn

    s = get_settings()
    uvicorn.run(
        "app.main:app",
        host=s.host,
        port=s.port,
        app_dir=str(PROJECT_ROOT / "backend"),
        reload=False,
    )


if __name__ == "__main__":
    run()
