from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

import api.auth as auth
import api.main as api_main
from analysts.store import IntentStore
from analysts.technical import TechnicalAnalyst
from api.main import app
from config.settings import Settings
from core.models import AnalystRequest, AssetClass, Bar, IntentSide

START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def closes_from_deltas(deltas: list[float], length: int = 71) -> list[float]:
    price = 100.0
    closes = [price]
    for index in range(length - 1):
        price += deltas[index % len(deltas)]
        closes.append(round(price, 4))
    return closes


def make_bars(closes: list[float], symbol: str = "BTC-USDT") -> list[Bar]:
    return [
        Bar(
            symbol=symbol,
            asset_class=AssetClass.CRYPTO,
            timestamp=START + timedelta(hours=index),
            open=close,
            high=close * 1.004,
            low=close * 0.996,
            close=close,
            volume=1_000.0,
        )
        for index, close in enumerate(closes)
    ]


UPTREND = closes_from_deltas([1.2, -0.9, 1.1, -0.8])
DOWNTREND = [round(200 - close, 4) for close in UPTREND]


def test_uptrend_emits_buy_with_written_thesis() -> None:
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(UPTREND), mode="paper")
    )

    assert outcome.intent is not None
    intent = outcome.intent
    assert intent.side is IntentSide.BUY
    assert intent.mode == "paper"
    assert intent.stop_loss < intent.reference_price < intent.take_profit
    assert 0.0 < intent.confidence <= 0.92
    assert intent.quantity > 0
    assert "technical-momentum" in intent.thesis
    assert "RSI(14)" in intent.thesis
    assert "Paper only" in intent.thesis
    assert "BTC" in intent.thesis


def test_timeframe_defaults_to_one_hour() -> None:
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(UPTREND), mode="paper")
    )

    assert outcome.intent is not None
    assert outcome.intent.timeframe == "1h"
    assert "1h chart" in outcome.intent.thesis


def test_requested_timeframe_is_echoed_and_named_in_the_thesis() -> None:
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(
            symbol="BTC-USDT", bars=make_bars(UPTREND), mode="paper", timeframe="4h"
        )
    )

    assert outcome.intent is not None
    assert outcome.intent.timeframe == "4h"
    assert "4h chart" in outcome.intent.thesis
    assert "12 4h bars" in outcome.intent.thesis


def test_unknown_timeframe_is_rejected_by_the_endpoint(monkeypatch) -> None:
    test_settings = Settings(api_access_token="test-token")
    monkeypatch.setattr(auth, "settings", test_settings)
    monkeypatch.setattr(api_main, "settings", test_settings)
    monkeypatch.setattr(api_main, "is_kill_switch_active", lambda: False)

    response = TestClient(app).post(
        "/api/v1/analyst/intents",
        json={
            "symbol": "BTC-USDT",
            "mode": "paper",
            "timeframe": "3h",
            "bars": [bar.model_dump(mode="json") for bar in make_bars(UPTREND)],
        },
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 422


def test_downtrend_emits_sell_with_inverted_risk_levels() -> None:
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(DOWNTREND), mode="paper")
    )

    assert outcome.intent is not None
    intent = outcome.intent
    assert intent.side is IntentSide.SELL
    assert intent.take_profit < intent.reference_price < intent.stop_loss


def test_overbought_rally_stands_aside_with_a_reason() -> None:
    closes = [round(100 + index * 0.4, 4) for index in range(71)]
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(closes), mode="analysis")
    )

    assert outcome.intent is None
    assert "overbought" in outcome.note


def test_short_window_stands_aside() -> None:
    outcome = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(UPTREND[:10]), mode="analysis")
    )

    assert outcome.intent is None
    assert "at least 40" in outcome.note


def test_intent_never_carries_an_order_endpoint() -> None:
    payload = TechnicalAnalyst().analyse(
        AnalystRequest(symbol="BTC-USDT", bars=make_bars(UPTREND), mode="paper")
    ).intent
    assert payload is not None
    dump = payload.model_dump(mode="json")
    assert dump["order_type"] == "market"
    assert "broker" not in dump


def test_api_generates_and_stores_intent(monkeypatch, tmp_path) -> None:
    test_settings = Settings(api_access_token="test-token")
    ledger = tmp_path / "intents.db"
    monkeypatch.setattr(auth, "settings", test_settings)
    monkeypatch.setattr(api_main, "settings", test_settings)
    monkeypatch.setattr(api_main, "intent_store", IntentStore(ledger))
    monkeypatch.setattr(api_main, "is_kill_switch_active", lambda: False)

    response = TestClient(app).post(
        "/api/v1/analyst/intents",
        json={
            "symbol": "BTC-USDT",
            "asset_class": "crypto",
            "mode": "paper",
            "bars": [bar.model_dump(mode="json") for bar in make_bars(UPTREND)],
        },
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent"]["side"] == "buy"
    assert body["strategy"] == {"name": "technical-momentum", "version": "1.0.0"}

    with sqlite3.connect(ledger) as db:
        stored = db.execute("SELECT symbol FROM trade_intents").fetchall()
    assert stored == [("BTC-USDT",)]


def test_api_rejects_live_mode(monkeypatch) -> None:
    test_settings = Settings(api_access_token="test-token")
    monkeypatch.setattr(auth, "settings", test_settings)
    monkeypatch.setattr(api_main, "settings", test_settings)
    monkeypatch.setattr(api_main, "is_kill_switch_active", lambda: False)

    response = TestClient(app).post(
        "/api/v1/analyst/intents",
        json={
            "symbol": "BTC-USDT",
            "mode": "live",
            "bars": [bar.model_dump(mode="json") for bar in make_bars(UPTREND)],
        },
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 400


def test_api_refuses_to_emit_when_kill_switch_is_active(monkeypatch) -> None:
    test_settings = Settings(api_access_token="test-token")
    monkeypatch.setattr(auth, "settings", test_settings)
    monkeypatch.setattr(api_main, "settings", test_settings)
    monkeypatch.setattr(api_main, "is_kill_switch_active", lambda: True)

    response = TestClient(app).post(
        "/api/v1/analyst/intents",
        json={
            "symbol": "BTC-USDT",
            "mode": "paper",
            "bars": [bar.model_dump(mode="json") for bar in make_bars(UPTREND)],
        },
        headers={"Authorization": "Bearer test-token"},
    )

    assert response.status_code == 409


def test_analyst_endpoint_requires_auth() -> None:
    response = TestClient(app).post("/api/v1/analyst/intents", json={})
    assert response.status_code == 401
