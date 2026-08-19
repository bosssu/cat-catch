from __future__ import annotations

import time

from app.core.models import MediaCandidate, MediaType, SourceKind
from app.ui.download_job import DownloadJob


def test_download_job_reports_progress_and_done():
    steps: list[tuple[int, int | None]] = []

    def materialize(c, progress_cb=None):
        if progress_cb:
            progress_cb(0, 1000, "direct")
            progress_cb(400, 1000, "direct")
            progress_cb(1000, 1000, "direct")
            steps.append((1000, 1000))
        c.local_path = "/tmp/x.mp4"
        c.meta["media_complete"] = True
        return True, "direct"

    c = MediaCandidate(
        media_type=MediaType.VIDEO,
        source_kind=SourceKind.NETWORK,
        source_url="https://example.com/a.mp4",
    )
    job = DownloadJob(materialize, [c])
    job.start()
    # wait for completion
    for _ in range(50):
        if job.snapshot().done:
            break
        time.sleep(0.05)
    snap = job.snapshot()
    assert snap.done
    assert snap.ok == 1
    assert snap.fail == 0
    assert snap.value == 1000
    assert steps  # progress_cb was invoked
