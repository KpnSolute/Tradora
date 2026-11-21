"""Analyst layer: turns market data into reviewable, paper-only trade intents.

Analysts never place orders. They emit a :class:`core.models.TradeIntent`
carrying the numbers behind the idea plus a written thesis, and a human
decides whether the proposal is approved into simulated paper trading.
"""
