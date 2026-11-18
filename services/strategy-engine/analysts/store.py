"""Audit trail for intents emitted by the analyst layer.

The engine keeps its own append-only record so a proposal can be replayed even
if the product database is rebuilt. The browser-facing, per-user copy of these
intents lives in the Express gateway's Postgres ``trade_intents`` table.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from core.models import TradeIntent


class IntentStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS trade_intents ("
                "intent_id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, "
                "symbol TEXT NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL, "
                "confidence REAL NOT NULL, payload TEXT NOT NULL)"
            )

    def save(self, intent: TradeIntent) -> None:
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "INSERT OR REPLACE INTO trade_intents VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    intent.intent_id,
                    intent.generated_at.isoformat(),
                    intent.symbol,
                    intent.side.value,
                    intent.mode,
                    intent.confidence,
                    json.dumps(intent.model_dump(mode="json")),
                ),
            )
