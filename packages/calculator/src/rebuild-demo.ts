/**
 * Projection Rebuild Demo
 *
 * Demonstrates how app.reset() enables projection rebuilds:
 * 1. Build a counter app with a projection that sums increments
 * 2. Process events through the projection normally
 * 3. Reset the projection watermark with app.reset()
 * 4. Re-drain to replay all events through the (potentially updated) projection
 *
 * Run: pnpm -F calculator dev:rebuild
 */
import { act, dispose, projection, state } from "@rotorsoft/act";
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
  // --- V1 projection: just counts events ---
  let totalEvents = 0;
  let totalSum = 0;

  const SumProjection = projection("sum-proj")
    .on({ Incremented })
    .do(async function projectSum(event) {
      await Promise.resolve();
      totalEvents++;
      totalSum += event.data.by;
    })
    .build();

  const app = act().withState(Counter).withProjection(SumProjection).build();

  const actor = { id: "demo", name: "Demo User" };
  const stream = "counter-1";

  // Emit some events
  console.log("=== Emitting events ===");
  for (const by of [10, 20, 30, 40, 50]) {
    await app.do("increment", { stream, actor }, { by });
    console.log(`  increment by ${by}`);
  }

  // Process events through projection
  await app.correlate();
  await app.drain({ eventLimit: 100 });

  console.log(`\n=== After initial drain ===`);
  console.log(`  Events processed: ${totalEvents}`);
  console.log(`  Sum: ${totalSum}`);

  const snap = await app.load(Counter, stream);
  console.log(`  Counter state: ${snap.state.count}`);

  // --- Now simulate a projection logic change ---
  // In production you'd deploy new code; here we just reset and re-drain
  console.log(`\n=== Resetting projection for rebuild ===`);
  totalEvents = 0;
  totalSum = 0;

  const resetCount = await app.reset(["sum-proj"]);
  console.log(`  Reset ${resetCount} stream(s)`);

  // Re-drain replays all events from the beginning
  await app.drain({ eventLimit: 100 });

  console.log(`\n=== After rebuild ===`);
  console.log(`  Events re-processed: ${totalEvents}`);
  console.log(`  Sum (rebuilt): ${totalSum}`);

  // Verify consistency
  console.log(`\n=== Verification ===`);
  console.log(
    `  Counter state matches sum: ${snap.state.count === totalSum ? "✓" : "✗"}`
  );

  // --- Demonstrate idempotent rebuild ---
  console.log(`\n=== Second rebuild (idempotent) ===`);
  totalEvents = 0;
  totalSum = 0;
  await app.reset(["sum-proj"]);
  await app.drain({ eventLimit: 100 });
  console.log(`  Events re-processed: ${totalEvents}`);
  console.log(`  Sum: ${totalSum}`);
  console.log(`  Same result: ${totalSum === snap.state.count ? "✓" : "✗"}`);

  await dispose()();
}

void main();
