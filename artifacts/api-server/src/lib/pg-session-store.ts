import session from "express-session";
import { pool } from "@workspace/db";
import { logger } from "./logger";

type Done = (err?: unknown) => void;

const TABLE = "user_sessions";
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function expiryOf(sess: session.SessionData): Date {
  const expires = sess.cookie?.expires;
  if (expires) return new Date(expires);
  const maxAge = sess.cookie?.maxAge;
  return new Date(Date.now() + (typeof maxAge === "number" ? maxAge : DEFAULT_MAX_AGE));
}

/**
 * Session storage in Postgres, sharing the app's existing pool. A hosted
 * instance restarts (and free tiers also sleep), which wipes an in-memory
 * store and silently logs everyone out; rows survive both.
 */
export class PgSessionStore extends session.Store {
  private ready: Promise<void>;

  constructor() {
    super();
    this.ready = this.init();
    void this.ready.catch((err) => logger.error({ err }, "session store init failed"));
  }

  private async init(): Promise<void> {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         sid text PRIMARY KEY,
         sess json NOT NULL,
         expire timestamptz NOT NULL
       )`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_expire_idx ON ${TABLE} (expire)`,
    );
    await this.prune();
    // Expired rows would otherwise accumulate forever; unref so the timer
    // never keeps the process alive on shutdown.
    setInterval(() => void this.prune(), 60 * 60 * 1000).unref();
  }

  private async prune(): Promise<void> {
    try {
      const result = await pool.query(`DELETE FROM ${TABLE} WHERE expire < now()`);
      if (result.rowCount) {
        logger.info({ removed: result.rowCount }, "Pruned expired sessions");
      }
    } catch (err) {
      logger.warn({ err }, "Session prune failed");
    }
  }

  get(
    sid: string,
    callback: (err: unknown, sess?: session.SessionData | null) => void,
  ): void {
    this.ready
      .then(async () => {
        const { rows } = await pool.query(
          `SELECT sess FROM ${TABLE} WHERE sid = $1 AND expire > now()`,
          [sid],
        );
        callback(null, rows.length ? (rows[0].sess as session.SessionData) : null);
      })
      .catch((err) => callback(err));
  }

  set(sid: string, sess: session.SessionData, callback?: Done): void {
    this.ready
      .then(async () => {
        await pool.query(
          `INSERT INTO ${TABLE} (sid, sess, expire) VALUES ($1, $2::json, $3)
           ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
          [sid, JSON.stringify(sess), expiryOf(sess)],
        );
        callback?.();
      })
      .catch((err) => callback?.(err));
  }

  touch(sid: string, sess: session.SessionData, callback?: Done): void {
    this.ready
      .then(async () => {
        await pool.query(`UPDATE ${TABLE} SET expire = $2 WHERE sid = $1`, [
          sid,
          expiryOf(sess),
        ]);
        callback?.();
      })
      .catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: Done): void {
    this.ready
      .then(async () => {
        await pool.query(`DELETE FROM ${TABLE} WHERE sid = $1`, [sid]);
        callback?.();
      })
      .catch((err) => callback?.(err));
  }

  length(callback: (err: unknown, length?: number) => void): void {
    this.ready
      .then(async () => {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS count FROM ${TABLE} WHERE expire > now()`,
        );
        callback(null, rows[0].count);
      })
      .catch((err) => callback(err));
  }

  clear(callback?: Done): void {
    this.ready
      .then(async () => {
        await pool.query(`DELETE FROM ${TABLE}`);
        callback?.();
      })
      .catch((err) => callback?.(err));
  }
}
