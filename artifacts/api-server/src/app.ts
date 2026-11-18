import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import fs from "node:fs";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";

const app: Express = express();

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

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile native, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow any replit.dev subdomain (covers web terminal + Expo web preview)
    if (/\.replit\.dev$/.test(origin) || /\.repl\.co$/.test(origin)) {
      return callback(null, true);
    }
    // Allow localhost for local development
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`), false);
  },
  credentials: true,
}));
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
  app.use(express.static(webRoot));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws")) {
      next();
      return;
    }
    res.sendFile(path.join(webRoot, "index.html"));
  });
}

export default app;
export { sessionMiddleware };
