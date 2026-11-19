import session from "express-session";
import { PgSessionStore } from "./pg-session-store";

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set");
}

export const sessionMiddleware = session({
  store: new PgSessionStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
});

// Extend the session type
declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}
