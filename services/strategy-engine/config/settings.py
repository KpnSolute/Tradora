from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


SERVICE_ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = SERVICE_ROOT / "logs"
KILL_SWITCH_PATH = SERVICE_ROOT / "KILL_SWITCH.flag"
load_dotenv(SERVICE_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    api_access_token: str = os.getenv("STRATEGY_ENGINE_API_ACCESS_TOKEN", "")
    alpaca_base_url: str = os.getenv(
        "ALPACA_BASE_URL", "https://paper-api.alpaca.markets"
    )
    remote_clear_allowed: bool = (
        os.getenv("REMOTE_CLEAR_ALLOWED", "false").lower() == "true"
    )
    max_daily_loss_pct: float = float(os.getenv("MAX_DAILY_LOSS_PCT", "1.0"))
    max_position_pct_of_equity: float = float(
        os.getenv("MAX_POSITION_PCT_OF_EQUITY", "5.0")
    )
    host: str = "127.0.0.1"
    port: int = 8787


settings = Settings()
LOG_DIR.mkdir(exist_ok=True)
