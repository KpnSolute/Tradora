import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import fs from "node:fs";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";

const app: Express = express();

// Hosted deploys terminate TLS at the proxy. Without this, `req.secure` is false
// behind Render's edge and the production (secure) session cookie is never set.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Same-origin is the production topology (the API serves the built SPA), and
// browsers still send `Origin` on crossorigin module/stylesheet requests, so a
// strict external allowlist would 500 the app's own assets and blank the page.
const extraOrigins = new Set(
  [process.env.APP_ORIGIN, process.env.CORS_ORIGINS]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

app.use((req, res, next) =>
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile native, curl, server-to-server)
      if (!origin) return callback(null, true);
      const originHost = origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
      // Same origin as this server: always fine, whatever the host
      if (originHost === req.headers.host) return callback(null, true);
      if (extraOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
      // Replit preview domains (covers web terminal + Expo web preview)
      if (/\.replit\.dev$/.test(originHost) || /\.repl\.co$/.test(originHost)) {
        return callback(null, true);
      }
      // Local development
      if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin ${origin} not allowed`), false);
    },
    credentials: true,
  })(req, res, next),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

app.use("/api", router);

/**
 * Production topology: one origin for the SPA and the API. Serving the built
 * terminal here keeps the session cookie same-site and the /ws upgrade
 * same-origin, so no CORS allowlist or cross-site cookie is needed.
 */
const webRoot = path.resolve(process.cwd(), "artifacts/trading-terminal/dist/public");
if (process.env.SERVE_WEB === "true" && fs.existsSync(path.join(webRoot, "index.html"))) {
  // Read once at startup: res.sendFile resolves relative to the request and
  // failed on the Windows drive path, while static served the same file fine.
  const indexHtml = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
  app.use(express.static(webRoot));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    res.type("html").send(indexHtml);
  });
}

export default app;
export { sessionMiddleware };
