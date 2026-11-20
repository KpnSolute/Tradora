# NEXUS Trading Terminal

A professional dark-mode crypto trading terminal for power users. Supports live market feeds, candlestick charts, buy/sell signals, paper/real trading mode toggle, watchlist subscriptions, trade history, portfolio analytics, and connected account management.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/trading-terminal run dev` — run the frontend (auto-assigned port)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — Express session secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS + shadcn/ui + recharts + wouter
- API: Express 5 + WebSocket (`ws`) for live ticker feeds
- DB: PostgreSQL + Drizzle ORM
- Auth: Username/password via bcryptjs + express-session
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth)
- `lib/db/src/schema/` — Drizzle table definitions (users, watchlist, trades, trading_accounts)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, markets, watchlist, trades, portfolio, accounts, settings)
- `artifacts/api-server/src/lib/market-data.ts` — Kraken price cache (WS v2 ticks reconciled by a REST snapshot), real OHLC candles, indicator-based signals
- `artifacts/api-server/src/lib/websocket.ts` — client ticker fan-out, Kraken WS v2 stream, automation engine
- `artifacts/trading-terminal/src/` — React frontend (pages: login, register, dashboard, market/:symbol, trades, portfolio, accounts, settings)

## Architecture decisions

- Market data uses the Kraken public API (no key): `wss://ws.kraken.com/v2` ticker ticks fill the in-memory cache, and a REST snapshot refetches anything older than 15s, so a cold start or a dropped stream still serves a real exchange price. No placeholder/seed prices exist — a price is either from Kraken or absent.
- Candlesticks are the real OHLCV series from Kraken's `/0/public/OHLC`.
- Trading signals are computed from that series: RSI(14), MACD(12,26,9), an EMA(26) trend read, and support/resistance from recent swing lows/highs.
- Paper trading balance starts at $10,000 virtual funds; real trading mode requires connecting an exchange account.
- WebSocket path `/ws` is registered in the API server's `artifact.toml` paths alongside `/api` so the proxy forwards upgrades.
- Used `bcryptjs` (pure JS) instead of `bcrypt` to avoid native build approval requirement on Replit.

## Product

- **Login / Register** — username + password auth, no email required
- **Dashboard** — live market overview with trending coins, personal watchlist with real-time tickers via WebSocket
- **Market detail** — candlestick chart (recharts) with interval selector (1m/5m/15m/1h/4h/1d), signal panel (strong buy → strong sell), simulated order book, quick-trade panel
- **Trades** — full trade history with PnL per trade and status badges
- **Portfolio** — open positions, PnL summary, win rate, best/worst trade
- **Accounts** — connect exchange accounts (API key + secret), manage connections
- **Settings** — paper/real trading mode toggle

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After OpenAPI spec changes, always run codegen before using updated types: `pnpm --filter @workspace/api-spec run codegen`
- After DB schema changes, run `pnpm run typecheck:libs` before checking leaf packages so fresh declarations are available
- Orval collision: operations with BOTH path params AND query params generate `<Op>Params` in both Zod barrel and types/ — fix by embedding query params as path segments
- bcrypt needs native builds; use bcryptjs instead
- `/ws` must be in api-server artifact.toml paths or WebSocket connections are silently dropped

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
