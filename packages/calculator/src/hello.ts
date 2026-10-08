/**
 * The smallest Act app with a reaction: two counters, and a reaction that
 * keeps a running total of everything they count. Start here, then read
 * `main.ts` for lanes, projections and more.
 *
 * Run it: `pnpm -F calculator dev:hello`
 */
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

// A state: one counter per stream. Actions decide, events record, the
// patch folds each event into the state.
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ by: z.number() }) })
  .patch({ Incremented: ({ data }, s) => ({ count: s.count + data.by }) })
  .on({ increment: z.object({ by: z.number() }) })
  .emit("Incremented")
  .build();

// A second state the reaction writes to.
const Total = state({ Total: z.object({ sum: z.number() }) })
  .init(() => ({ sum: 0 }))
  .emits({ Added: z.object({ by: z.number() }) })
  .patch({ Added: ({ data }, s) => ({ sum: s.sum + data.by }) })
  .on({ add: z.object({ by: z.number() }) })
  .emit("Added")
  .build();

const actor = { id: "1", name: "hello" };

// The reaction: every Incremented adds to the total.
const app = act()
  .withState(Counter)
  .withState(Total)
  .on("Incremented")
  .do(async function addToTotal(event) {
    await app.do("add", { stream: "total", actor }, { by: event.data.by });
  })
  .to("totals")
  .build();

// Run reactions after each commit, and print the result once they settle.
app.on("committed", () => app.settle());
app.on("settled", async () => {
  const a = await app.load(Counter, "a");
  const b = await app.load(Counter, "b");
  const total = await app.load(Total, "total");
  console.log({ a: a.state.count, b: b.state.count, total: total.state.sum });
});

await app.do("increment", { stream: "a", actor }, { by: 1 });
await app.do("increment", { stream: "b", actor }, { by: 2 });
await app.do("increment", { stream: "a", actor }, { by: 3 });
