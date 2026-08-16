from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

from core.models import Event


class EventBus:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.subscribers: set[asyncio.Queue[Event]] = set()
        self.db_path.parent.mkdir(exist_ok=True)
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS events ("
                "event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, "
                "event_type TEXT NOT NULL, severity TEXT NOT NULL, payload TEXT NOT NULL)"
            )

    def publish(self, event: Event) -> None:
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "INSERT OR REPLACE INTO events VALUES (?, ?, ?, ?, ?)",
                (
                    event.event_id,
                    event.timestamp.isoformat(),
                    event.type.value,
                    event.severity,
                    json.dumps(event.model_dump(mode="json")),
                ),
            )
        for queue in tuple(self.subscribers):
            queue.put_nowait(event)

    def subscribe(self) -> asyncio.Queue[Event]:
        queue: asyncio.Queue[Event] = asyncio.Queue()
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Event]) -> None:
        self.subscribers.discard(queue)
