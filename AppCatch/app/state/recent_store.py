from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from app.core.config import ROOT
from app.core.models import RecentItem

STORE_PATH = ROOT / "data" / "recent.json"
MAX_ITEMS = 50


class RecentStore:
    def __init__(self, path: Path = STORE_PATH):
        self.path = path
        self.items: list[RecentItem] = []
        self.load()

    def load(self) -> None:
        self.items = []
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            for row in raw:
                ca = row.get("created_at")
                if isinstance(ca, str):
                    row["created_at"] = datetime.fromisoformat(ca)
                self.items.append(RecentItem(**{k: row[k] for k in RecentItem.__dataclass_fields__ if k in row}))
        except Exception:
            self.items = []

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = []
        for it in self.items[:MAX_ITEMS]:
            d = asdict(it)
            if isinstance(d.get("created_at"), datetime):
                d["created_at"] = d["created_at"].isoformat()
            payload.append(d)
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def add(self, item: RecentItem) -> None:
        self.items.insert(0, item)
        self.items = self.items[:MAX_ITEMS]
        self.save()

    def clear_display(self) -> None:
        self.items = []
        self.save()
