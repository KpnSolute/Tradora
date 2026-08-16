from __future__ import annotations

from strategies.base import Strategy


class StrategyRegistry:
    def __init__(self) -> None:
        self._strategies: dict[str, Strategy] = {}

    def register(self, strategy: Strategy) -> None:
        if strategy.name in self._strategies:
            raise ValueError(f"Strategy already registered: {strategy.name}")
        self._strategies[strategy.name] = strategy

    def get(self, name: str) -> Strategy:
        try:
            return self._strategies[name]
        except KeyError as exc:
            raise KeyError(f"Unknown strategy: {name}") from exc

    def list(self) -> list[dict[str, str]]:
        return [
            {"name": item.name, "version": item.version}
            for item in sorted(self._strategies.values(), key=lambda item: item.name)
        ]


registry = StrategyRegistry()
