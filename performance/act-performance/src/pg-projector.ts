/**
 * Projection table for fast reads.
 * Updated by event handlers.
 */
import type { CommittedOf } from "@rotorsoft/act";
import { Pool } from "pg";
import { Events } from "./todo";

export function create() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  return {
    init: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS performance.todos_projection (
          id VARCHAR(50) PRIMARY KEY,
          text TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP,
          deleted BOOLEAN DEFAULT FALSE
        );
      `);
    },
    projectTodoCreated: async (
      event: CommittedOf<typeof Events, "TodoCreated">
    ) => {
      await pool.query(
        "INSERT INTO performance.todos_projection (id, text, created_at, deleted) VALUES ($1, $2, $3, FALSE) ON CONFLICT (id) DO NOTHING",
        [event.stream, event.data.text, event.created.toISOString()]
      );
    },
    projectTodoUpdated: async (
      event: CommittedOf<typeof Events, "TodoUpdated">
    ) => {
      await pool.query(
        "UPDATE performance.todos_projection SET text=$2, updated_at=$3 WHERE id=$1",
        [event.stream, event.data.text, event.created.toISOString()]
      );
    },
    projectTodoDeleted: async (
      event: CommittedOf<typeof Events, "TodoDeleted">
    ) => {
      await pool.query(
        "UPDATE performance.todos_projection SET deleted=TRUE, updated_at=$2 WHERE id=$1",
        [event.stream, event.created.toISOString()]
      );
    },
    getById: async (stream: string) => {
      const res = await pool.query(
        "SELECT * FROM performance.todos_projection WHERE id=$1 AND deleted=FALSE",
        [stream]
      );
      return res.rows[0] || null;
    },
    getStats: async () => {
      const totals = await pool.query(`
        SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE deleted=FALSE)::int AS active FROM performance.todos_projection`);
      const events = await pool.query(
        `SELECT MAX(id) as last_event_id FROM performance.events`
      );
      return {
        totalTodos: totals.rows[0]?.total || 0,
        activeTodos: totals.rows[0]?.active || 0,
        lastEventInStore: events.rows[0]?.last_event_id || 0,
      };
    },
  };
}
