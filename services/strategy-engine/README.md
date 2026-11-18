# Tradora Strategy Engine

Internal, localhost-only strategy, risk, analysis, and paper-trading service for
Tradora. Express remains the browser-facing product gateway; this service must
never be called directly by browser code.

V1 permits only `analysis`, `dry_run`, and `paper` modes. It exposes no order
submission endpoint and defaults Alpaca configuration to the paper endpoint.

## Analyst (Agent Feed)

`POST /api/v1/analyst/intents` takes a bar window plus paper equity and returns
one reviewable `TradeIntent` (side, size, stop, target, confidence, thesis) or
`intent: null` with a reason for standing aside. The requested `timeframe`
(`15m`, `1h`, `4h` or `1d`, default `1h`) is echoed onto the intent and named in
the thesis, so the bar interval a proposal came from stays auditable. Intents are appended to
`logs/intents.db` for audit. The endpoint never places an order: approval into
paper trading happens in the Express gateway's `trade_intents` table.

## Local validation

```powershell
python -m pytest -q
```

## Local run

Set `STRATEGY_ENGINE_API_ACCESS_TOKEN` in the process environment, then run:

```powershell
python -m uvicorn api.main:app --host 127.0.0.1 --port 8787
```
