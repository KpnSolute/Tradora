// Tradora edge gateway: public app + Access-protected strategy engine.
// Both origins currently run on Render. Never embed Access tokens here.
const PUBLIC_HOST = "tradora.kpnsolute.com";
const APP_ORIGIN = "https://tradora.onrender.com";
const ENGINE_ORIGIN = "https://tradora-engine.onrender.com";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (incoming.hostname !== PUBLIC_HOST) {
      return new Response("Not found", { status: 404 });
    }

    // The base path is not an API route. Only /engine/* is proxied and
    // protected by the corresponding Cloudflare Access Service Auth app.
    if (incoming.pathname === "/engine") {
      return new Response("Not found", { status: 404 });
    }
    const isEngine = incoming.pathname.startsWith("/engine/");
    const origin = isEngine ? ENGINE_ORIGIN : APP_ORIGIN;
    const upstreamPath = isEngine ? incoming.pathname.slice("/engine".length) : incoming.pathname;
    const target = new URL(upstreamPath + incoming.search, origin);
    const upstreamRequest = new Request(target, request);
    const headers = upstreamRequest.headers;

    // Keep existing Express same-origin validation for the public app.
    // Untrusted cross-origin browser requests remain unmodified.
    if (!isEngine && headers.get("Origin") === incoming.origin) {
      headers.set("Origin", APP_ORIGIN);
    }
    headers.delete("x-forwarded-host");

    if (isEngine) {
      // Access authenticates at the Cloudflare edge; the service token should
      // not be sent to the Render origin or exposed in application logs.
      headers.delete("CF-Access-Client-Id");
      headers.delete("CF-Access-Client-Secret");
      headers.delete("CF-Access-Jwt-Assertion");
      headers.delete("Cookie");
    }

    try {
      const upstream = await fetch(upstreamRequest, { redirect: "manual" });
      // Retain WebSocket upgrade responses without reconstructing them.
      if (upstream.status === 101) return upstream;

      const responseHeaders = new Headers(upstream.headers);
      const location = responseHeaders.get("Location");
      if (location) {
        const redirect = new URL(location, origin);
        if (redirect.origin === origin) {
          const prefix = isEngine ? "/engine" : "";
          responseHeaders.set("Location", incoming.origin + prefix + redirect.pathname + redirect.search + redirect.hash);
        }
      }
      if (isEngine || incoming.pathname.startsWith("/api/") || incoming.pathname === "/ws") {
        responseHeaders.set("Cache-Control", "no-store");
      }
      responseHeaders.set("X-Tradora-Edge", "cloudflare-worker");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (_error) {
      return new Response("Tradora upstream is temporarily unavailable", {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  },
};
