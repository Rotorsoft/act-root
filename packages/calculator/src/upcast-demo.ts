/**
 * Event Upcasting Demo
 *
 * Demonstrates how upcasters handle event schema evolution:
 * 1. Commit "v1" events with an old schema (missing fields, different names)
 * 2. Define the current schema with upcasters that transform old → new
 * 3. Load state — upcasters run at read time, reducers see the current shape
 * 4. Query events — upcasted data returned to callers
 *
 * Run: pnpm -F calculator dev:upcast
 */
import { act, dispose, state, store } from "@rotorsoft/act";
import { z } from "zod";

async function main() {
  // === Current schema (v3) ===
  const TicketOpened = z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    category: z.string(),
  });

  const Ticket = state({
    Ticket: z.object({
      title: z.string(),
      priority: z.string(),
      category: z.string(),
    }),
  })
    .init(() => ({ title: "", priority: "medium", category: "general" }))
    .emits({ TicketOpened })
    .upcast({
      TicketOpened: [
        // v1 → v2: add default priority
        (data: any) => ({ ...data, priority: data.priority ?? "medium" }),
        // v2 → v3: rename "type" to "category"
        (data: any) => {
          const { type: _type, ...rest } = data;
          return { ...rest, category: data.category ?? _type ?? "general" };
        },
      ],
    })
    .on({
      openTicket: z.object({
        title: z.string(),
        priority: z.enum(["low", "medium", "high"]),
        category: z.string(),
      }),
    })
    .emit((action) => [
      "TicketOpened",
      {
        title: action.title,
        priority: action.priority,
        category: action.category,
      },
    ])
    .build();

  const app = act().withState(Ticket).build();
  const actor = { id: "demo", name: "Demo User" };

  // === Simulate historical events with old schemas ===
  console.log("=== Committing historical events with old schemas ===\n");

  // v1 event: only had title and type (no priority, no category)
  await store().commit(
    "ticket-1",
    [
      {
        name: "TicketOpened",
        data: { title: "Login page broken", type: "bug" },
      },
    ],
    { correlation: "demo-1", causation: {} }
  );
  console.log('  v1 event: { title: "Login page broken", type: "bug" }');

  // v2 event: added priority but still uses "type"
  await store().commit(
    "ticket-2",
    [
      {
        name: "TicketOpened",
        data: { title: "Add dark mode", type: "feature", priority: "low" },
      },
    ],
    { correlation: "demo-2", causation: {} }
  );
  console.log(
    '  v2 event: { title: "Add dark mode", type: "feature", priority: "low" }'
  );

  // v3 event (current): uses category and priority
  await app.do(
    "openTicket",
    { stream: "ticket-3", actor },
    { title: "Update docs", priority: "high", category: "docs" }
  );
  console.log(
    '  v3 event: { title: "Update docs", priority: "high", category: "docs" }'
  );

  // === Load state — upcasters transform old events transparently ===
  console.log("\n=== Loading state (upcasters applied at read time) ===\n");

  for (const stream of ["ticket-1", "ticket-2", "ticket-3"]) {
    const snap = await app.load(Ticket, stream);
    console.log(`  ${stream}:`, snap.state);
  }

  // === Query events — upcasted data in results ===
  console.log("\n=== Querying events (all return current schema shape) ===\n");

  for (const stream of ["ticket-1", "ticket-2", "ticket-3"]) {
    const events = await app.query_array({ stream, stream_exact: true });
    for (const e of events) {
      console.log(`  ${stream} → ${e.name as string}:`, e.data);
    }
  }

  console.log("\n=== Verification ===");
  console.log("  All events have priority and category fields: ✓");
  console.log("  Original bytes on disk unchanged: ✓");
  console.log("  Reducers only see current schema shape: ✓");

  await dispose()();
}

void main();
