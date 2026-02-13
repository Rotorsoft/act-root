/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-expressions */
/**
 * Type-level diagnostics - NOT a runtime test file.
 * Verified by: npx tsc --noEmit
 * This file ensures autocompletion and type safety through the builder chain.
 * Each @ts-expect-error must fire (unused directive = regression).
 */
import { z } from "zod";
import { act, slice, state } from "../src/index.js";

// ── Define test states ──────────────────────────────────────────────
const Counter = state("Counter", z.object({ count: z.number() }))
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.amount }),
  })
  .on("increment", z.object({ by: z.number() }))
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const Logger = state("Logger", z.object({ entries: z.number() }))
  .init(() => ({ entries: 0 }))
  .emits({ Logged: z.object({ message: z.string() }) })
  .patch({ Logged: (_, s) => ({ entries: s.entries + 1 }) })
  .on("log", z.object({ message: z.string() }))
  .emit((a) => ["Logged", { message: a.message }])
  .build();

const target = { stream: "s1", actor: { id: "1", name: "test" } };

// ── TEST 1: act().with(State) accumulates action types ──────────────
{
  const app = act().with(Counter).build();
  void app.do("increment", target, { by: 5 });
  // @ts-expect-error - "nonexistent" is not a valid action
  void app.do("nonexistent", target, {});
  // @ts-expect-error - wrong payload shape
  void app.do("increment", target, { wrong: "field" });
}

// ── TEST 2: act().with(State).on() autocompletes events ─────────────
{
  const _app = act()
    .with(Counter)
    .on("Incremented")
    .do(async (event) => {
      const _amount: number = event.data.amount;
    })
    .void()
    .build();
}

// ── TEST 3: Multiple .with() accumulates all types ──────────────────
{
  const app = act().with(Counter).with(Logger).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "hello" });
  // @ts-expect-error - wrong payload for this action
  void app.do("log", target, { by: 1 });
}

// ── TEST 4: .on() in builder sees all accumulated events ────────────
{
  const _builder = act()
    .with(Counter)
    .with(Logger)
    .on("Incremented")
    .do(async (event) => {
      const _amt: number = event.data.amount;
    })
    .void()
    .on("Logged")
    .do(async (event) => {
      const _msg: string = event.data.message;
    })
    .void();
}

// ── TEST 5: slice().with(State) scopes events ───────────────────────
{
  const _s = slice()
    .with(Counter)
    .on("Incremented")
    .do(async (event) => {
      const _amount: number = event.data.amount;
    })
    .void()
    .build();
}

// ── TEST 6: act().with(Slice) merges types correctly ────────────────
{
  const CounterSlice = slice().with(Counter).build();
  const LoggerSlice = slice().with(Logger).build();
  const app = act().with(CounterSlice).with(LoggerSlice).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
  // @ts-expect-error - wrong payload
  void app.do("increment", target, { message: "wrong" });
}

// ── TEST 7: Cross-slice reactions at act level ──────────────────────
{
  const CounterSlice = slice().with(Counter).build();
  const LoggerSlice = slice().with(Logger).build();
  const _app = act()
    .with(CounterSlice)
    .with(LoggerSlice)
    .on("Incremented")
    .do(async (event) => {
      const _amount: number = event.data.amount;
    })
    .void()
    .on("Logged")
    .do(async (event) => {
      const _msg: string = event.data.message;
    })
    .void()
    .build();
}

// ── TEST 8: load() with state name ──────────────────────────────────
{
  const app = act().with(Counter).with(Logger).build();
  void app.load(Counter, "s1").then((snap) => {
    const _count: number = snap.state.count;
  });
  void app.load("Counter", "s1").then((snap) => {
    const _count: number = snap.state.count;
  });
}

// ── TEST 9: drain() return type uses app's event types ──────────────
{
  const app = act().with(Counter).build();
  void app.drain().then((result) => {
    if (result.fetched.length > 0) {
      const _event = result.fetched[0].events[0];
      const s: string = "hello";
      // @ts-expect-error - event.name is "Incremented", not assignable from arbitrary string
      const _check: typeof _event.name = s;
    }
  });
}

// ── TEST 10: query() return type preserves event types ──────────────
{
  const app = act().with(Counter).with(Logger).build();
  void app.query({ stream: "s1" }).then(({ first }) => {
    if (first) {
      const s: string = "hello";
      // @ts-expect-error - event.name is "Incremented" | "Logged", not arbitrary string
      const _check: typeof first.name = s;
    }
  });
}

// ── TEST 11: load by name provides typed state ──────────────────────
{
  const app = act().with(Counter).with(Logger).build();
  void app.load("Counter", "s1").then((snap) => {
    const _count: number = snap.state.count;
    // @ts-expect-error - Logger props shouldn't be on Counter snapshot
    snap.state.entries;
  });
}

// ── TEST 12: Mixed slices and direct states ─────────────────────────
{
  const CounterSlice = slice().with(Counter).build();
  const app = act().with(CounterSlice).with(Logger).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
}
