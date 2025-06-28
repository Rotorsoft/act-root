import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import path from "path";
import { fileURLToPath } from "url";

const db_path = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../local.db"
);

const client = createClient({ url: `file:${db_path}` });
export const db = drizzle(client);

export async function init_tickets_db() {
  await db.run("PRAGMA journal_mode=WAL;");
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

export { tickets } from "./schema.js";
