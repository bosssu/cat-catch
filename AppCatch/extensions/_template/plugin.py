"""Optional L-B hooks. Delete this file to use pure manifest (L-A) only."""

from __future__ import annotations

from typing import Any


def collect_candidates(ctx: Any, session: Any) -> list:
    """Return list[MediaCandidate]. Empty is fine."""
    return []


def on_network_item(ctx: Any, session: Any, raw: Any) -> list:
    return []


def before_ingest(ctx: Any, candidate: Any) -> Any:
    """Optional mutate/annotate candidate right before LMW ingest."""
    return candidate
