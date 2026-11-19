# Tradora edge (Cloudflare)

The public entry point is `https://tradora.kpnsolute.com`, served by the Cloudflare
Worker `tradora-edge-api` in zone `kpnsolute.com`. The Worker reverse-proxies
everything to the Render application at `https://tradora.onrender.com`.

```
browser ──TLS──▶ Cloudflare edge (Worker) ──HTTP──▶ Render: Express API + built SPA
                                                     └─▶ Supabase (Postgres)
                                                     └─▶ tradora-engine.onrender.com (Python)
```

## Files

| File | Purpose |
|---|---|
| `tradora-edge-worker.mjs` | Worker source: reverse proxy, WebSocket passthrough, cache and header policy |
| `wrangler.toml` | Worker name, custom-domain route, origin variable |

## Deploying

Deploys run only from `main` or an explicit manual dispatch:

```bash
gh workflow run deploy-worker.yml            # deploy
gh workflow run deploy-worker.yml -f dry_run=true
```

Required repository secrets:

| Secret | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Wrangler authentication (needs *Workers Scripts: Edit* and *Zone: Workers Routes: Edit*) |
| `CLOUDFLARE_ACCOUNT_ID` | Target account |

`CLOUDFLARE_ZONE_ID` is not needed — the route in `wrangler.toml` uses `zone_name`.
Add it only if you move to a `zone_id`-based route.

Local check without deploying:

```bash
cd cloudflare && npx wrangler deploy --dry-run --outdir dist
```

## Behaviour the Worker must keep

- **No caching of authenticated traffic.** `/api/*` and WebSocket upgrades are
  returned with `Cache-Control: no-store`, and `ETag`/`Last-Modified` are dropped.
  Sessions, trade intents and account data must never be stored at the edge.
- **Origin stays strict.** `Origin` is forwarded untouched; only `X-Forwarded-Host`
  and `X-Forwarded-Proto` are added. The API compares the request origin against
  its own host, so the public hostname must reach Express intact.
- **No infrastructure leakage.** `x-powered-by`, `x-render-origin-server`, `rndr-id`
  and `server` are stripped from responses. No secrets or broker keys are ever
  placed in Worker variables.
- **WebSockets pass through.** A `101` response is returned with the upstream
  socket attached, so `/ws` keeps working for live tickers and automation events.

## What the edge does *not* do

Cloudflare is the public edge, not the authorisation layer:

- Express still authenticates every API request; the Worker adds no access control.
- The Render origin (`https://tradora.onrender.com`) remains separately reachable.
  Disabling the Render subdomain (`renderSubdomainPolicy: disabled`) is the way to
  make the custom domain the only entrance, and it requires a verified custom
  domain on the Render service.
- Render's inbound IP allowlist is a Scale/Enterprise feature, so it cannot be used
  on the current Hobby workspace. Until then the bearer token on the strategy
  engine is the backend control that matters.

## Strategy engine

`https://tradora-engine.onrender.com` is a Render web service, so it is reachable
from the internet. It authenticates with a bearer token and is called only by the
Express API (`STRATEGY_ENGINE_BASE_URL` + `STRATEGY_ENGINE_API_ACCESS_TOKEN`).

The engine gets no hostname of its own. The Worker strips the `/engine` prefix and
forwards to the engine, and a Cloudflare Zero Trust self-hosted application guards
that path, so the only intended entrance is:

    https://tradora.kpnsolute.com/engine  ->  https://tradora-engine.onrender.com

Setup (applied in production):

1. Zero Trust → Access → Applications → *Self-hosted* on `tradora.kpnsolute.com`
   with path `engine`, policy type **Service Auth**. No other policy: humans have
   no reason to reach the engine.
2. Create a **service token** and put it on the Render **API** service as
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The API sends
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` on every engine call.
3. Set the API's `STRATEGY_ENGINE_BASE_URL=https://tradora.kpnsolute.com/engine` and
   confirm the Agent Feed still generates intents.
4. Only then disable the Render engine's public `onrender.com` subdomain, keeping
   the bearer token as the second layer.

Check both layers from a shell:

    curl -s -o /dev/null -w '%{http_code}\n' https://tradora.kpnsolute.com/engine/healthz  # 401: Access
    curl -s -o /dev/null -w '%{http_code}\n' https://tradora.kpnsolute.com/api/healthz     # 200: path-scoped

Add `-H` with the token's client id/secret headers to the first call to get
`200 {"status":"ok"}`. The Worker drops `set-cookie` on `/engine/*`, so the
`CF_Authorization` JWT Cloudflare mints for a service-token request never reaches
a browser.

Step 4 is the one gap that remains: `tradora-engine.onrender.com` still answers
directly. Do not disable it while `ENGINE_URL` points at that hostname — it is the
Worker's only path to the engine. Closing it needs the engine behind its own
verified Render custom domain (and the service token held by the Worker instead of
the API).
