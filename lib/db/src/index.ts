import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Hosted Postgres (Supabase's pooler, Render) refuses plaintext connections and
  // advertises that via sslmode. Local dev URLs omit it and keep connecting unencrypted.
  ...(/sslmode=(require|verify-ca|verify-full)/.test(process.env.DATABASE_URL) ||
  process.env.DATABASE_SSL === "true"
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
