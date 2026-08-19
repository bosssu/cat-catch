from pathlib import Path

import httpx

from app.jobs import JobStore
from app.lmw import is_retryable, upload_with_retry


def test_enqueue_dedupes_same_url():
    tmp_path = Path(__file__).resolve().parent / "_tmp_jobs"
    tmp_path.mkdir(exist_ok=True)
    store = JobStore(
        {"max_height": 1080, "ios_lock": False, "lmw": {"upload": False}, "keep_file": True},
        tmp_path,
        start_worker=False,
    )
    a = store.enqueue("https://example.com/watch?v=1", title="a")
    b = store.enqueue("https://example.com/watch?v=1", title="b")
    assert a["id"] == b["id"]
    assert a["status"] == "queued"


def test_enqueue_rejects_bad_url():
    tmp_path = Path(__file__).resolve().parent / "_tmp_jobs"
    tmp_path.mkdir(exist_ok=True)
    store = JobStore({"lmw": {"upload": False}}, tmp_path, start_worker=False)
    try:
        store.enqueue("not-a-url")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_cancel_queued_job():
    tmp_path = Path(__file__).resolve().parent / "_tmp_jobs"
    tmp_path.mkdir(exist_ok=True)
    store = JobStore({"lmw": {"upload": False}}, tmp_path, start_worker=False)
    a = store.enqueue("https://example.com/watch?v=cancel-me")
    b = store.enqueue("https://example.com/watch?v=other")
    out = store.cancel(a["id"])
    assert out is not None
    assert out["status"] == "cancelled"
    assert store.get(a["id"])["status"] == "cancelled"
    assert store.get(b["id"])["status"] == "queued"


def test_upload_retryable_kinds():
    assert is_retryable(httpx.ConnectError("down"))
    assert is_retryable(httpx.ReadTimeout("slow"))
    req = httpx.Request("POST", "http://127.0.0.1/api/upload")
    resp = httpx.Response(503, request=req)
    assert is_retryable(httpx.HTTPStatusError("busy", request=req, response=resp))
    resp400 = httpx.Response(400, request=req)
    assert not is_retryable(httpx.HTTPStatusError("bad", request=req, response=resp400))
    assert not is_retryable(FileNotFoundError("x"))


def test_upload_with_retry_gives_up_on_client_error():
    tmp_path = Path(__file__).resolve().parent / "_tmp_jobs"
    tmp_path.mkdir(exist_ok=True)
    f = tmp_path / "retry_bad.mp4"
    f.write_bytes(b"x" * 64)
    calls = {"n": 0}

    def boom(*_a, **_k):
        calls["n"] += 1
        req = httpx.Request("POST", "http://127.0.0.1/api/upload")
        resp = httpx.Response(400, request=req)
        raise httpx.HTTPStatusError("bad", request=req, response=resp)

    import app.lmw as lmw

    orig = lmw.upload
    lmw.upload = boom  # type: ignore[method-assign]
    try:
        try:
            upload_with_retry("http://127.0.0.1:8790", f, attempts=3, backoff=0.2)
            assert False, "expected HTTPStatusError"
        except httpx.HTTPStatusError:
            pass
        assert calls["n"] == 1
    finally:
        lmw.upload = orig


def test_upload_with_retry_retries_then_ok():
    tmp_path = Path(__file__).resolve().parent / "_tmp_jobs"
    tmp_path.mkdir(exist_ok=True)
    f = tmp_path / "retry_ok.mp4"
    f.write_bytes(b"x" * 64)
    calls = {"n": 0}

    def flaky(*_a, **_k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("down")
        return {"id": "ok"}

    import app.lmw as lmw

    orig = lmw.upload
    lmw.upload = flaky  # type: ignore[method-assign]
    try:
        res = upload_with_retry("http://127.0.0.1:8790", f, attempts=3, backoff=0.2)
        assert res["id"] == "ok"
        assert calls["n"] == 3
    finally:
        lmw.upload = orig
