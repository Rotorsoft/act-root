import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

// Spec files run in parallel, one SQLite file per vitest worker: on a shared
// file, a projection write that loses the lock waits out the reaction backoff.
const worker = process.env.VITEST_POOL_ID;
const db_path = worker
  ? path.join(tmpdir(), `wolfdesk-test-${worker}.db`)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../local.db");

const client = createClient({ url: `file:${db_path}` });
export const db = drizzle(client);

export async function init_tickets_db() {
  await db.run("PRAGMA busy_timeout=5000;");
  await db.run("PRAGMA journal_mode=WAL;");
  await db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      support_category_id TEXT NOT NULL,
      open INTEGER NOT NULL
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      support_category_id TEXT NOT NULL,
      escalation_id TEXT,
      priority TEXT NOT NULL,
      title TEXT NOT NULL,
      messages INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT,
      resolved_by_id TEXT,
      closed_by_id TEXT,
      reassign_after INTEGER,
      escalate_after INTEGER,
      close_after INTEGER
    );
  `);
}

export { agents, tickets } from "./schema.js";
