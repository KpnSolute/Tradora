from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class AssetClass(str, Enum):
    STOCKS = "stocks"
    CRYPTO = "crypto"


class SignalDirection(str, Enum):
    BUY = "buy"
    SELL = "sell"
    HOLD = "hold"


class IntentSide(str, Enum):
    BUY = "buy"
    SELL = "sell"


class EventType(str, Enum):
    SIGNAL_GENERATED = "signal_generated"
    ORDER_SUBMITTED = "order_submitted"
    ORDER_FILLED = "order_filled"
    RISK_LIMIT_BREACHED = "risk_limit_breached"
    KILL_SWITCH_TRIPPED = "kill_switch_tripped"
    DAILY_LOSS_LIMIT_HIT = "daily_loss_limit_hit"


class Bar(BaseModel):
    symbol: str
    asset_class: AssetClass
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


class Signal(BaseModel):
    signal_id: str = Field(default_factory=lambda: str(uuid4()))
    symbol: str
    asset_class: AssetClass
    direction: SignalDirection
    strategy_name: str
    confidence: float = Field(ge=0.0, le=1.0)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = Field(default_factory=dict)


class Event(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid4()))
    type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    symbol: str | None = None
    strategy_name: str | None = None
    severity: str = "info"
    payload: dict[str, Any] = Field(default_factory=dict)


class AnalystRequest(BaseModel):
    """Bars plus the account context needed to size a paper intent."""

    symbol: str = Field(min_length=3, max_length=24)
    asset_class: AssetClass = AssetClass.CRYPTO
    bars: list[Bar] = Field(min_length=1)
    mode: str = "analysis"
    equity: float = Field(default=10_000.0, gt=0)
    risk_pct_of_equity: float | None = Field(default=None, gt=0, le=100)


class TradeIntent(BaseModel):
    """A paper-only proposal a human can approve or reject."""

    intent_id: str = Field(default_factory=lambda: str(uuid4()))
    symbol: str
    asset_class: AssetClass
    side: IntentSide
    quantity: float = Field(gt=0)
    order_type: str = "market"
    reference_price: float = Field(gt=0)
    stop_loss: float = Field(gt=0)
    take_profit: float = Field(gt=0)
    confidence: float = Field(ge=0.0, le=1.0)
    thesis: str = Field(min_length=20)
    strategy_name: str
    strategy_version: str
    mode: str
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    indicators: dict[str, float] = Field(default_factory=dict)


class KillSwitchRequest(BaseModel):
    enabled: bool
    source: str = "api"


class ScanRequest(BaseModel):
    mode: str = "dry_run"
    asset_class: AssetClass = AssetClass.STOCKS
