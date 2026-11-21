"""Deterministic technical indicators used by the analyst layer.

Everything here is pure math over the bars the caller supplies: no network
access, no randomness, and no order side effects. Keeping the indicators
deterministic is what makes an intent's thesis reproducible and auditable.
"""

from __future__ import annotations

from collections.abc import Sequence

from core.models import Bar


def ema_series(values: Sequence[float], period: int) -> list[float]:
    """Exponential moving average seeded with the first value."""
    if period <= 0:
        raise ValueError("period must be positive")
    if not values:
        return []

    smoothing = 2.0 / (period + 1.0)
    series = [float(values[0])]
    for value in values[1:]:
        series.append(value * smoothing + series[-1] * (1.0 - smoothing))
    return series


def rsi(values: Sequence[float], period: int = 14) -> float | None:
    """Wilder's relative strength index over the trailing ``period`` changes."""
    if period <= 0 or len(values) < period + 1:
        return None

    window = values[-period - 1 :]
    gains = 0.0
    losses = 0.0
    for previous, current in zip(window, window[1:]):
        delta = current - previous
        if delta >= 0:
            gains += delta
        else:
            losses -= delta

    average_gain = gains / period
    average_loss = losses / period
    if average_loss == 0:
        return 100.0 if average_gain > 0 else 50.0

    relative_strength = average_gain / average_loss
    return 100.0 - 100.0 / (1.0 + relative_strength)


def atr(bars: Sequence[Bar], period: int = 14) -> float | None:
    """Average true range over the trailing ``period`` bars."""
    if period <= 0 or len(bars) < period + 1:
        return None

    window = bars[-period - 1 :]
    true_ranges: list[float] = []
    for previous, current in zip(window, window[1:]):
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )

    return sum(true_ranges) / period


def pct_change(values: Sequence[float], lookback: int) -> float | None:
    """Percentage change between the last value and ``lookback`` bars earlier."""
    if lookback <= 0 or len(values) <= lookback:
        return None

    base = values[-lookback - 1]
    if base == 0:
        return None

    return (values[-1] / base - 1.0) * 100.0
