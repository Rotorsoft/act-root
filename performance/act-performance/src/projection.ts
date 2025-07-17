/**
 * Projection table for fast reads.
 * Updated by event handlers.
 */
import { Committed } from "@rotorsoft/act";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function projectTodoCreated(event: Committed<any, any>) {
  await pool.query(
    "INSERT INTO performance.todos_projection (id, text, created_at, deleted) VALUES ($1, $2, $3, FALSE) ON CONFLICT (id) DO NOTHING",
    [event.stream, event.data.text, event.created.toISOString()]
  );
}

export async function projectTodoUpdated(event: Committed<any, any>) {
  await pool.query(
    "UPDATE performance.todos_projection SET text=$2, updated_at=$3 WHERE id=$1",
    [event.stream, event.data.text, event.created.toISOString()]
  );
}

export async function projectTodoDeleted(event: Committed<any, any>) {
  await pool.query(
    "UPDATE performance.todos_projection SET deleted=TRUE, updated_at=$2 WHERE id=$1",
    [event.stream, event.created.toISOString()]
  );
}

export async function initProjection() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS performance.todos_projection (
      id VARCHAR(50) PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP,
      deleted BOOLEAN DEFAULT FALSE
    );
  `);
}

export async function getById(stream: string) {
  const res = await pool.query(
    "SELECT * FROM performance.todos_projection WHERE id=$1 AND deleted=FALSE",
    [stream]
  );
  return res.rows[0] || null;
}

export async function getAll() {
  const res = await pool.query(
    "SELECT * FROM performance.todos_projection WHERE deleted=FALSE"
  );
  return res.rows;
}

export async function getTodosStats() {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE deleted=FALSE)::int AS active FROM performance.todos_projection`
  );
  return {
    totalTodos: res.rows[0]?.total || 0,
    activeTodos: res.rows[0]?.active || 0,
  };
}

export async function getEventsStats() {
  const res = await pool.query(`
    SELECT
      (SELECT MAX(id) FROM performance.events) AS last_event_id,
      (SELECT MAX(at) FROM performance.events_streams) AS last_event_at
  `);
  return {
    lastEventInStore: res.rows[0]?.last_event_id || 0,
    lastProjectedEvent: res.rows[0]?.last_event_at || 0,
  };
}
