from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.routes import public_router, router
from app.core.config import PROJECT_ROOT, get_settings
from app.core.db import init_db
from app.services.download import start_worker

STATIC_DIR = PROJECT_ROOT / "frontend" / "public"
logger = logging.getLogger("lmw")


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
    _install_asyncio_quiet_handler()
    get_settings().ensure_dirs()
    init_db()
    await start_worker()
    yield


app = FastAPI(title="LocalMediaWeb", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public_router)
app.include_router(router)


@app.get("/")
def index():
    index_path = STATIC_DIR / "index.html"
    if index_path.is_file():
        return FileResponse(index_path)
    return {"message": "LocalMediaWeb API", "docs": "/docs", "health": "/api/health"}


if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


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
