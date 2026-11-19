/**
 * Tradora edge Worker — the public entry point for https://tradora.kpnsolute.com.
 *
 * It reverse-proxies every request (HTML, JS/CSS, /api/*, and the /ws upgrade)
 * to the Render origin that runs the Express API and serves the built SPA.
 * Cloudflare is the public edge; it is NOT the authorisation layer. Express still
 * authenticates every request, and Render remains separately reachable.
 *
 * `/engine/*` is the one exception: the prefix is stripped and the request is sent
 * to the private strategy engine (FastAPI on Render), so the engine has a single
 * front door. A Cloudflare Access self-hosted application guards that path, so
 * unauthenticated callers are rejected at the edge; the API server authenticates
 * with its service token (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) plus
 * its bearer token.
 *
 * Rules this file must keep:
 *  - Never cache authenticated responses: /api/*, /engine/* and the WebSocket
 *    upgrade are always revalidated with `no-store`, never stored at the edge.
 *  - Never expose origin internals: `x-powered-by`, `x-render-origin-server` and
 *    other framework fingerprints are stripped on the way out.
 *  - Never hand a visitor the Access session cookie. Cloudflare answers a
 *    service-token request with `set-cookie: CF_Authorization`, and that JWT
 *    authorises the engine for 24 hours; it is dropped on /engine/* so it never
 *    reaches a browser.
 *  - Preserve the public hostname so the API's same-origin check keeps working
 *    (see `X-Forwarded-Host`), and keep `Origin` untouched so CORS stays strict.
 */

const ORIGIN_URL = "https://tradora.onrender.com";
const ENGINE_URL = "https://tradora-engine.onrender.com";
const ENGINE_PREFIX = "/engine";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

const STRIPPED_RESPONSE_HEADERS = [
  "x-powered-by",
  "x-render-origin-server",
  "rndr-id",
  "server",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { isEngine, target } = resolveUpstream(url, env);

    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const isSocket = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
    const isPrivate = isApi || isEngine;

    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    let upstream;
    try {
      upstream = await fetch(new Request(target.toString(), init));
    } catch (err) {
      // Render free instances wake from sleep; a cold start can exceed the
      // default fetch window. Report it honestly instead of a blank page.
      console.log(JSON.stringify({ event: "origin_fetch_failed", path: url.pathname, message: String(err) }));
      if (isApi || isEngine) {
        return json({ error: "Upstream unavailable, please retry" }, 502);
      }
      return new Response("Upstream unavailable, please retry", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" },
      });
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name);

    if (isEngine) {
      // The engine is machine-to-machine only: no cookie must travel back out.
      responseHeaders.delete("Set-Cookie");
    }

    if (isPrivate || isSocket) {
      // Sessions, trades and account data must never be served from a cache.
      responseHeaders.set("Cache-Control", "no-store");
      responseHeaders.delete("ETag");
      responseHeaders.delete("Last-Modified");
    }

    responseHeaders.set("X-Tradora-Edge", "cloudflare-worker");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      responseHeaders.set(name, value);
    }

    if (upstream.status === 101) {
      return new Response(null, {
        status: 101,
        webSocket: upstream.webSocket,
        headers: responseHeaders,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * Split the public path between the Express origin and the strategy engine.
 * `/engine` and `/engine/*` map to `/` and `/*` on the engine; everything else
 * keeps its path on the app origin.
 */
function resolveUpstream(url, env) {
  const isEngine =
    url.pathname === ENGINE_PREFIX || url.pathname.startsWith(`${ENGINE_PREFIX}/`);

  if (!isEngine) {
    const appOrigin = new URL(env.ORIGIN_URL || ORIGIN_URL);
    return { isEngine: false, target: new URL(url.pathname + url.search, appOrigin) };
  }

  const suffix = url.pathname.slice(ENGINE_PREFIX.length);
  const path = suffix === "" ? "/" : suffix.startsWith("/") ? suffix : `/${suffix}`;
  const engineOrigin = new URL(env.ENGINE_URL || ENGINE_URL);
  return { isEngine: true, target: new URL(path + url.search, engineOrigin) };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
