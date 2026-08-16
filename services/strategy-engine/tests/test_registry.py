from __future__ import annotations

from collections.abc import Sequence

import pytest

from core.models import Bar, Signal
from strategies.base import Strategy
from strategies.registry import StrategyRegistry


class ExampleStrategy(Strategy):
    name = "example"

    def evaluate(self, bars: Sequence[Bar]) -> list[Signal]:
        return []


def test_registry_lists_registered_strategies() -> None:
    registry = StrategyRegistry()
    registry.register(ExampleStrategy())
    assert registry.list() == [{"name": "example", "version": "1.0.0"}]


def test_registry_rejects_duplicate_names() -> None:
    registry = StrategyRegistry()
    registry.register(ExampleStrategy())
    with pytest.raises(ValueError, match="already registered"):
        registry.register(ExampleStrategy())
