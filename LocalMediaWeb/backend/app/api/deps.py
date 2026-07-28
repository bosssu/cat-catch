from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.core.config import get_settings


def require_token(
    x_lmw_token: str | None = Header(default=None, alias="X-LMW-Token"),
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    expected = (settings.access_token or "").strip()
    if not expected:
        return
    token = (x_lmw_token or "").strip()
    if not token and authorization:
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        else:
            token = auth
    if token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
