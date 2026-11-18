"""Deterministic technical analyst that emits reviewable trade intents.

Design constraints (Phase 1):
  * Paper only. The analyst never submits an order; it returns a proposal that a
    human approves or rejects in the Agent Feed.
  * No language model in the hot path. The written thesis is composed from the
    same numbers the decision used, so it can be audited and reproduced.
  * One intent per call, or none. Standing aside is a first-class outcome and
    comes with a reason.
"""

from __future__ import annotations

from dataclasses import dataclass

from analysts import indicators
from config.settings import settings
from core.models import AnalystRequest, IntentSide, TradeIntent


@dataclass(frozen=True)
class AnalystOutcome:
    intent: TradeIntent | None
    note: str


def _round_price(value: float) -> float:
    if value >= 100:
        return round(value, 2)
    if value >= 1:
        return round(value, 4)
    return round(value, 6)


def _money(value: float) -> str:
    return f"{value:,.2f}" if abs(value) >= 1 else f"{value:.6f}"


def _quantity(value: float) -> str:
    if value >= 1:
        return f"{value:,.4f}".rstrip("0").rstrip(".")
    return f"{value:.8f}".rstrip("0").rstrip(".")


class TechnicalAnalyst:
    """Trend-following analyst over the caller's bar window."""

    name = "technical-momentum"
    version = "1.0.0"

    fast_period = 9
    slow_period = 21
    rsi_period = 14
    atr_period = 14
    momentum_lookback = 12
    min_bars = 40

    stop_atr_multiple = 2.0
    target_atr_multiple = 3.0
    momentum_threshold_pct = 0.4

    buy_rsi_range = (45.0, 72.0)
    sell_rsi_range = (28.0, 55.0)

    def analyse(self, request: AnalystRequest) -> AnalystOutcome:
        bars = list(request.bars)
        if len(bars) < self.min_bars:
            return AnalystOutcome(
                intent=None,
                note=(
                    f"Only {len(bars)} bars supplied; the analyst needs at least "
                    f"{self.min_bars} to compute a {self.slow_period}-period trend."
                ),
            )

        closes = [bar.close for bar in bars]
        price = closes[-1]

        fast_series = indicators.ema_series(closes, self.fast_period)
        slow_series = indicators.ema_series(closes, self.slow_period)
        fast_ema = fast_series[-1]
        slow_ema = slow_series[-1]
        previous_fast = fast_series[-2]
        previous_slow = slow_series[-2]

        rsi_value = indicators.rsi(closes, self.rsi_period)
        atr_value = indicators.atr(bars, self.atr_period)
        momentum = indicators.pct_change(closes, self.momentum_lookback)

        if rsi_value is None or atr_value is None or momentum is None:
            return AnalystOutcome(
                intent=None,
                note="Indicator window is incomplete; no opinion on this symbol.",
            )

        if price <= 0:
            return AnalystOutcome(
                intent=None,
                note=f"Last close for {request.symbol} is not positive; skipping.",
            )

        if atr_value <= 0:
            return AnalystOutcome(
                intent=None,
                note=(
                    f"ATR({self.atr_period}) is zero for {request.symbol}: the bar "
                    "window has no range, so a stop distance cannot be defined."
                ),
            )

        trend_up = fast_ema > slow_ema
        crossed_up = previous_fast <= previous_slow and fast_ema > slow_ema
        crossed_down = previous_fast >= previous_slow and fast_ema < slow_ema

        indicators_snapshot = {
            "price": round(price, 8),
            "fast_ema": round(fast_ema, 8),
            "slow_ema": round(slow_ema, 8),
            "rsi": round(rsi_value, 4),
            "atr": round(atr_value, 8),
            "momentum_pct": round(momentum, 4),
        }

        side: IntentSide | None = None
        crossover = False

        if trend_up and momentum >= self.momentum_threshold_pct:
            low, high = self.buy_rsi_range
            if low <= rsi_value <= high:
                side = IntentSide.BUY
                crossover = crossed_up
        elif not trend_up and momentum <= -self.momentum_threshold_pct:
            low, high = self.sell_rsi_range
            if low <= rsi_value <= high:
                side = IntentSide.SELL
                crossover = crossed_down

        if side is None:
            return AnalystOutcome(
                intent=None,
                note=self._stand_aside_note(
                    symbol=request.symbol,
                    trend_up=trend_up,
                    rsi_value=rsi_value,
                    momentum=momentum,
                ),
            )

        stop_distance = atr_value * self.stop_atr_multiple
        target_distance = atr_value * self.target_atr_multiple
        if side is IntentSide.BUY:
            stop_loss = _round_price(price - stop_distance)
            take_profit = _round_price(price + target_distance)
        else:
            stop_loss = _round_price(price + stop_distance)
            take_profit = _round_price(price - target_distance)

        if stop_loss <= 0 or take_profit <= 0:
            return AnalystOutcome(
                intent=None,
                note=(
                    f"ATR-based stop or target for {request.symbol} lands at or below "
                    "zero; the volatility is too large relative to price to size this idea."
                ),
            )

        risk_pct = request.risk_pct_of_equity or settings.max_position_pct_of_equity
        notional = request.equity * (risk_pct / 100.0)
        quantity = round(notional / price, 8)
        if quantity <= 0:
            return AnalystOutcome(
                intent=None,
                note=(
                    f"A {risk_pct:.2f}% allocation of {_money(request.equity)} is too "
                    f"small to buy any {request.symbol} at {_money(price)}."
                ),
            )

        separation_pct = abs(fast_ema / slow_ema - 1.0) * 100.0
        confidence = 0.45
        confidence += min(0.20, separation_pct * 0.20)
        confidence += min(0.15, abs(momentum) * 0.04)
        if crossover:
            confidence += 0.07
        if 50.0 <= rsi_value <= 65.0:
            confidence += 0.05
        confidence = round(min(0.92, max(0.05, confidence)), 4)

        intent = TradeIntent(
            symbol=request.symbol,
            asset_class=request.asset_class,
            side=side,
            quantity=quantity,
            order_type="market",
            reference_price=_round_price(price),
            stop_loss=stop_loss,
            take_profit=take_profit,
            confidence=confidence,
            thesis=self._thesis(
                symbol=request.symbol,
                side=side,
                price=price,
                fast_ema=fast_ema,
                slow_ema=slow_ema,
                rsi_value=rsi_value,
                momentum=momentum,
                atr_value=atr_value,
                stop_loss=stop_loss,
                take_profit=take_profit,
                crossover=crossover,
                quantity=quantity,
                risk_pct=risk_pct,
            ),
            strategy_name=self.name,
            strategy_version=self.version,
            mode=request.mode,
            indicators=indicators_snapshot,
        )

        return AnalystOutcome(
            intent=intent,
            note=f"{side.value.upper()} proposal emitted for {request.symbol}.",
        )

    # ------------------------------------------------------------------ text

    def _thesis(
        self,
        *,
        symbol: str,
        side: IntentSide,
        price: float,
        fast_ema: float,
        slow_ema: float,
        rsi_value: float,
        momentum: float,
        atr_value: float,
        stop_loss: float,
        take_profit: float,
        crossover: bool,
        quantity: float,
        risk_pct: float,
    ) -> str:
        direction = "above" if side is IntentSide.BUY else "below"
        separation_pct = abs(price / slow_ema - 1.0) * 100.0
        stop_pct = abs(stop_loss / price - 1.0) * 100.0
        target_pct = abs(take_profit / price - 1.0) * 100.0

        if rsi_value >= 70:
            rsi_state = "high, but the trend has not broken"
        elif rsi_value <= 30:
            rsi_state = "low, but the downtrend is still intact"
        elif rsi_value >= 50:
            rsi_state = "in the bullish half without being stretched"
        else:
            rsi_state = "in the bearish half without being washed out"

        crossover_text = (
            f" The {self.fast_period}-period EMA has just crossed "
            f"{'above' if side is IntentSide.BUY else 'below'} the "
            f"{self.slow_period}-period EMA, which is what triggered this proposal."
            if crossover
            else ""
        )

        return (
            f"{symbol} {'long' if side is IntentSide.BUY else 'short'} idea from the "
            f"{self.name} analyst. Last close is {_money(price)}, {separation_pct:.2f}% "
            f"{direction} the {self.slow_period}-period EMA at {_money(slow_ema)}, with "
            f"the {self.fast_period}-period EMA at {_money(fast_ema)}. "
            f"RSI({self.rsi_period}) sits at {rsi_value:.1f}: {rsi_state}. "
            f"Momentum over the last {self.momentum_lookback} bars is "
            f"{momentum:+.2f}%.{crossover_text} "
            f"Sizing is {_quantity(quantity)} {symbol.split('-')[0]} "
            f"(a {risk_pct:.2f}% allocation). "
            f"Invalidation is {_money(stop_loss)} ({stop_pct:.2f}% away, "
            f"{self.stop_atr_multiple:.1f}x ATR({self.atr_period}) of "
            f"{_money(atr_value)}); the first target is {_money(take_profit)} "
            f"({target_pct:.2f}% away, {self.target_atr_multiple:.1f}x ATR). "
            "Paper only: approving this simulates the fill in the local paper book "
            "and nothing is routed to a live broker."
        )

    def _stand_aside_note(
        self, *, symbol: str, trend_up: bool, rsi_value: float, momentum: float
    ) -> str:
        low_buy, high_buy = self.buy_rsi_range
        low_sell, high_sell = self.sell_rsi_range

        if trend_up and rsi_value > high_buy:
            reason = (
                f"RSI({self.rsi_period}) at {rsi_value:.1f} is overbought on an "
                "uptrend; chasing here has poor risk/reward, so the analyst waits "
                "for a pullback."
            )
        elif trend_up:
            reason = (
                f"trend is up but {self.momentum_lookback}-bar momentum is only "
                f"{momentum:+.2f}%, below the {self.momentum_threshold_pct:.2f}% "
                "threshold the analyst requires to act."
            )
        elif rsi_value < low_sell:
            reason = (
                f"RSI({self.rsi_period}) at {rsi_value:.1f} is oversold on a "
                "downtrend; shorting into exhaustion is poor risk/reward."
            )
        else:
            reason = (
                f"trend is down and {self.momentum_lookback}-bar momentum is only "
                f"{momentum:+.2f}%, so there is no edge worth proposing."
            )

        return f"No intent for {symbol}: {reason}"
