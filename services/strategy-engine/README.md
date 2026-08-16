# Tradora Strategy Engine

Internal, localhost-only strategy, risk, analysis, and paper-trading service for
Tradora. Express remains the browser-facing product gateway; this service must
never be called directly by browser code.

V1 permits only `analysis`, `dry_run`, and `paper` modes. It exposes no order
submission endpoint and defaults Alpaca configuration to the paper endpoint.

## Local validation

```powershell
python -m pytest -q
```

## Local run

Set `STRATEGY_ENGINE_API_ACCESS_TOKEN` in the process environment, then run:

```powershell
python -m uvicorn api.main:app --host 127.0.0.1 --port 8787
```
