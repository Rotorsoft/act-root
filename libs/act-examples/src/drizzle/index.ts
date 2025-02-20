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
}

export { tickets } from "./schema";
