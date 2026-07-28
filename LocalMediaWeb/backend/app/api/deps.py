from __future__ import annotations

from fastapi import Header, HTTPException, Query, status

from app.core.config import get_settings


def require_token(
    x_lmw_token: str | None = Header(default=None, alias="X-LMW-Token"),
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None, description="Token for <video>/<img> src (mobile)"),
) -> None:
    """
    Accept token from:
    - Header X-LMW-Token
    - Authorization: Bearer …
    - Query ?token=… (needed for native media elements that cannot set headers)
    """
    settings = get_settings()
    expected = (settings.access_token or "").strip()
    if not expected:
        return
    got = (x_lmw_token or "").strip()
    if not got and authorization:
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            got = auth[7:].strip()
        else:
            got = auth
    if not got and token:
        got = token.strip()
    if got != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
