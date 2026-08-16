from __future__ import annotations

import pytest

import engine.safety as safety
from config.settings import Settings


def test_paper_endpoint_is_required(monkeypatch) -> None:
    monkeypatch.setattr(
        safety,
        "settings",
        Settings(alpaca_base_url="https://api.alpaca.markets"),
    )
    with pytest.raises(RuntimeError, match="not the paper trading endpoint"):
        safety.assert_paper_mode()


def test_kill_switch_refuses_submission(monkeypatch, tmp_path) -> None:
    flag = tmp_path / "KILL_SWITCH.flag"
    flag.touch()
    monkeypatch.setattr(safety, "KILL_SWITCH_PATH", flag)
    monkeypatch.setattr(
        safety,
        "settings",
        Settings(alpaca_base_url="https://paper-api.alpaca.markets"),
    )
    with pytest.raises(RuntimeError, match="kill switch is active"):
        safety.assert_order_submission_allowed()
