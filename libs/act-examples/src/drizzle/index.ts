import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import path from "path";
import { tickets } from "./schema";

const db_path = path.join(import.meta.dirname ?? __dirname, "../../local.db");
const client = createClient({ url: `file:${db_path}` });
const db = drizzle({ client });

void db.run("PRAGMA journal_mode=WAL;");

export { db, tickets };
