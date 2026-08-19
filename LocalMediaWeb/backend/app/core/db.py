from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, declarative_base, sessionmaker
from sqlalchemy.pool import NullPool

from .config import get_settings

Base = declarative_base()

_engine = None
SessionLocal = None


def init_db() -> None:
    global _engine, SessionLocal
    settings = get_settings()
    settings.ensure_dirs()
    url = f"sqlite:///{settings.db_path().as_posix()}"
    # SQLite + many concurrent HTTP streams: default QueuePool (5+10) exhausts when
    # FileResponse holds a Session open for the whole transfer. NullPool opens/closes
    # per checkout so we never hit "QueuePool limit ... connection timed out".
    _engine = create_engine(
        url,
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=NullPool,
        future=True,
    )

    @event.listens_for(_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    SessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)
    from app.models import entities  # noqa: F401

    Base.metadata.create_all(bind=_engine)
    _migrate_sqlite_columns(_engine)


def _migrate_sqlite_columns(engine) -> None:
    """Add new columns on existing SQLite DBs (create_all does not alter)."""
    alters = [
        ("media_items", "liked", "INTEGER DEFAULT 0"),
        ("media_items", "like_count", "INTEGER DEFAULT 0"),
        ("media_items", "skip_count", "INTEGER DEFAULT 0"),
        ("media_items", "view_count", "INTEGER DEFAULT 0"),
        ("media_items", "dwell_ms_total", "INTEGER DEFAULT 0"),
        ("media_items", "duration_sec", "REAL"),
        ("media_items", "max_progress", "REAL DEFAULT 0"),
        ("media_items", "last_position_sec", "REAL DEFAULT 0"),
        ("media_items", "last_viewed_at", "DATETIME"),
        ("media_items", "tags_json", "TEXT DEFAULT '[]'"),
        ("media_items", "review", "TEXT DEFAULT ''"),
        ("media_items", "content_hash", "TEXT DEFAULT ''"),
        ("download_jobs", "tags_json", "TEXT DEFAULT '[]'"),
        ("download_jobs", "use_jasna", "INTEGER DEFAULT 0"),
    ]
    with engine.begin() as conn:
        for table, col, typedef in alters:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            names = {r[1] for r in rows}
            if col not in names:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")


def get_db() -> Generator[Session, None, None]:
    if SessionLocal is None:
        init_db()
    assert SessionLocal is not None
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def session_scope() -> Session:
    """Return a new Session. Prefer ``with session_scope() as db:`` so it closes."""
    if SessionLocal is None:
        init_db()
    assert SessionLocal is not None
    return SessionLocal()
