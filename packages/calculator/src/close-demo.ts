/**
 * Close the Books Demo
 *
 * Demonstrates how app.close() enables safe stream archival and truncation:
 * 1. Build a counter app and emit events across multiple streams
 * 2. Drain all reactions so streams are fully settled
 * 3. Close streams — guard, archive, truncate + seed atomically
 * 4. Verify tombstoned streams reject writes
 * 5. Restart a stream with a snapshot of its final state
 *
 * Run: pnpm -F calculator dev:close
 */
import { act, dispose, state, StreamClosedError } from "@rotorsoft/act";
import { z } from "zod";

const Incremented = z.object({ by: z.number() });

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.by }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { by: action.by }])
  .build();

async function main() {
  const app = act().withState(Counter).build();

  const actor = { id: "demo", name: "Demo User" };

  // --- Step 1: Emit events across multiple streams ---
  console.log("=== Emitting events ===");
  for (const by of [10, 20, 30]) {
    await app.do("increment", { stream: "counter-A", actor }, { by });
    console.log(`  counter-A += ${by}`);
  }
  for (const by of [100, 200]) {
    await app.do("increment", { stream: "counter-B", actor }, { by });
    console.log(`  counter-B += ${by}`);
  }
  await app.do("increment", { stream: "counter-C", actor }, { by: 999 });
  console.log(`  counter-C += 999`);

  for (const stream of ["counter-A", "counter-B", "counter-C"]) {
    const snap = await app.load(Counter, stream);
    console.log(`  ${stream} state: count=${snap.state.count}`);
  }

  // --- Step 2: Archive and close A and B ---
  console.log("\n=== Closing counter-A and counter-B ===");
  const archive: Record<string, unknown[]> = {};

  const result = await app.close([
    {
      stream: "counter-A",
      archive: async () => {
        const events = await app.query_array({
          stream: "counter-A",
          stream_exact: true,
          with_snaps: true,
        });
        archive["counter-A"] = events;
        console.log(`  Archived ${events.length} events from counter-A`);
      },
    },
    { stream: "counter-B" },
  ]);

  console.log(`  Closed: ${[...result.truncated.keys()].join(", ")}`);
  let totalDeleted = 0;
  for (const { deleted } of result.truncated.values()) totalDeleted += deleted;
  console.log(`  Truncated: ${totalDeleted} events`);

  // --- Step 3: Verify tombstones block writes ---
  console.log("\n=== Verifying tombstone protection ===");
  try {
    await app.do("increment", { stream: "counter-A", actor }, { by: 1 });
    console.log("  ERROR: write should have been rejected!");
  } catch (error) {
    if (error instanceof StreamClosedError) {
      console.log(`  counter-A is closed: ${error.message}`);
    }
  }

  // counter-C is still open
  await app.do("increment", { stream: "counter-C", actor }, { by: 1 });
  const snapC = await app.load(Counter, "counter-C");
  console.log(`  counter-C is still open: count=${snapC.state.count}`);

  // --- Step 4: Close and restart counter-C ---
  console.log("\n=== Closing counter-C with restart ===");
  const restartResult = await app.close([
    {
      stream: "counter-C",
      restart: true,
      archive: async () => {
        const events = await app.query_array({
          stream: "counter-C",
          stream_exact: true,
          with_snaps: true,
        });
        archive["counter-C"] = events;
        console.log(`  Archived ${events.length} events from counter-C`);
      },
    },
  ]);

  console.log(`  Closed: ${[...restartResult.truncated.keys()].join(", ")}`);
  const restarted = [...restartResult.truncated.entries()]
    .filter(([, v]) => v.committed.name === "__snapshot__")
    .map(([k]) => k);
  console.log(`  Restarted: ${restarted.join(", ")}`);

  const snapRestarted = await app.load(Counter, "counter-C");
  console.log(
    `  counter-C restarted: count=${snapRestarted.state.count}, patches=${snapRestarted.patches}`
  );

  // --- Step 5: Show what's in the archive ---
  console.log("\n=== Archive contents ===");
  for (const [stream, events] of Object.entries(archive)) {
    console.log(
      `  ${stream}: ${(events as any[]).map((e: any) => `${e.name}(${JSON.stringify(e.data)})`).join(", ")}`
    );
  }

  // --- Step 6: Idempotency ---
  console.log("\n=== Idempotent close (counter-A already closed) ===");
  const idempotent = await app.close([{ stream: "counter-A" }]);
  console.log(
    `  Closed: ${idempotent.truncated.size}, Skipped: ${idempotent.skipped.length}`
  );
  console.log(`  (No-op — stream was already tombstoned)`);

  // --- Step 7: Show remaining events ---
  console.log("\n=== Events remaining in store ===");
  const allEvents: any[] = [];
  await app.query({ with_snaps: true }, (event) => allEvents.push(event));
  console.table(
    allEvents.map((e) => ({
      id: e.id,
      stream: e.stream,
      name: e.name,
      data: JSON.stringify(e.data),
    }))
  );

  await dispose()();
}

void main();
