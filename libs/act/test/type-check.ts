/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-expressions */
/**
 * Type-level diagnostics - NOT a runtime test file.
 * Verified by: npx tsc --noEmit
 * This file ensures autocompletion and type safety through the builder chain.
 * Each @ts-expect-error must fire (unused directive = regression).
 */
import { z } from "zod";
import { act, projection, slice, state } from "../src/index.js";

// ── Define test states ──────────────────────────────────────────────
const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, s) => ({ count: s.count + event.data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const Logger = state({ Logger: z.object({ entries: z.number() }) })
  .init(() => ({ entries: 0 }))
  .emits({ Logged: z.object({ message: z.string() }) })
  .patch({ Logged: (_, s) => ({ entries: s.entries + 1 }) })
  .on({ log: z.object({ message: z.string() }) })
  .emit((a) => ["Logged", { message: a.message }])
  .build();

const target = { stream: "s1", actor: { id: "1", name: "test" } };

// ── TEST 1: act().withState(State) accumulates action types ──────────────
{
  const app = act().withState(Counter).build();
  void app.do("increment", target, { by: 5 });
  // @ts-expect-error - "nonexistent" is not a valid action
  void app.do("nonexistent", target, {});
  // @ts-expect-error - wrong payload shape
  void app.do("increment", target, { wrong: "field" });
}

// ── TEST 2: act().withState(State).on() autocompletes events ─────────────
{
  const _app = act()
    .withState(Counter)
    .on("Incremented")
    .do(async (event) => {
      const _amount: number = event.data.amount;
    })
    .void()
    .build();
}

// ── TEST 3: Multiple .withState() accumulates all types ──────────────────
{
  const app = act().withState(Counter).withState(Logger).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "hello" });
  // @ts-expect-error - wrong payload for this action
  void app.do("log", target, { by: 1 });
}

// ── TEST 4: .on() in builder sees all accumulated events ────────────
{
  const _builder = act()
    .withState(Counter)
    .withState(Logger)
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

// ── TEST 5: slice().withState(State) scopes events ───────────────────────
{
  const _s = slice()
    .withState(Counter)
    .on("Incremented")
    .do(async (event) => {
      const _amount: number = event.data.amount;
    })
    .void()
    .build();
}

// ── TEST 6: act().withState(Slice) merges types correctly ────────────────
{
  const CounterSlice = slice().withState(Counter).build();
  const LoggerSlice = slice().withState(Logger).build();
  const app = act().withSlice(CounterSlice).withSlice(LoggerSlice).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
  // @ts-expect-error - wrong payload
  void app.do("increment", target, { message: "wrong" });
}

// ── TEST 7: Cross-slice reactions at act level ──────────────────────
{
  const CounterSlice = slice().withState(Counter).build();
  const LoggerSlice = slice().withState(Logger).build();
  const _app = act()
    .withSlice(CounterSlice)
    .withSlice(LoggerSlice)
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
  const app = act().withState(Counter).withState(Logger).build();
  void app.load(Counter, "s1").then((snap) => {
    const _count: number = snap.state.count;
  });
  void app.load("Counter", "s1").then((snap) => {
    const _count: number = snap.state.count;
  });
}

// ── TEST 9: drain() return type uses app's event types ──────────────
{
  const app = act().withState(Counter).build();
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
  const app = act().withState(Counter).withState(Logger).build();
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
  const app = act().withState(Counter).withState(Logger).build();
  void app.load("Counter", "s1").then((snap) => {
    const _count: number = snap.state.count;
    // @ts-expect-error - Logger props shouldn't be on Counter snapshot
    snap.state.entries;
  });
}

// ── TEST 12: Mixed slices and direct states ─────────────────────────
{
  const CounterSlice = slice().withState(Counter).build();
  const app = act().withSlice(CounterSlice).withState(Logger).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
}

// ── TEST 13: ReactionHandler.app is typed Dispatcher (not any) ──────
{
  const _app = act()
    .withState(Counter)
    .on("Incremented")
    .do(async (_event, _stream, app) => {
      // app should be Dispatcher<A>, not any — autocomplete works
      void app.do("increment", target, { by: 1 });
      // @ts-expect-error - wrong payload shape for typed Dispatcher
      void app.do("increment", target, { wrong: "field" });
    })
    .void()
    .build();
}

// ── TEST 14: Dispatcher.do() returns typed result (not any) ─────────
{
  const app = act().withState(Counter).build();
  void app.do("increment", target, { by: 1 }).then((snapshots) => {
    // Result is Snapshot[], not any
    const _patches: number = snapshots[0].patches;
    const _snaps: number = snapshots[0].snaps;
  });
}

// ── TEST 15: Standalone projection requires event-subset ────────────
{
  const Incremented = z.object({ amount: z.number() });
  const ValidProj = projection("counters")
    .on({ Incremented })
    .do(async () => {})
    .build();

  // Counter emits Incremented — this should compile
  void act().withState(Counter).withProjection(ValidProj);

  const Unknown = z.object({ x: z.number() });
  const InvalidProj = projection("other")
    .on({ Unknown })
    .do(async () => {})
    .build();

  // @ts-expect-error - Unknown is not in Counter's events
  void act().withState(Counter).withProjection(InvalidProj);
}

// ── TEST 16: Slice .on().do() handler app is typed Dispatcher ───────
{
  const _s = slice()
    .withState(Counter)
    .on("Incremented")
    .do(async (_event, _stream, app) => {
      void app.do("increment", target, { by: 1 });
      // @ts-expect-error - wrong payload shape
      void app.do("increment", target, { wrong: "field" });
    })
    .void()
    .build();
}

// ── TEST 17: slice().withState(State).withState(Proj) — types flow ────────────
{
  const Incremented = z.object({ amount: z.number() });
  const CounterProj = projection("counters")
    .on({ Incremented })
    .do(async (event) => {
      // Projection handler gets typed event data
      const _amt: number = event.data.amount;
    })
    .build();

  // Projection events are subset of slice events — should compile
  const _s = slice().withState(Counter).withProjection(CounterProj).build();
}

// ── TEST 18: slice+projection — event-subset constraint via .withState() ──
{
  const Unknown = z.object({ x: z.number() });
  const BadProj = projection("bad")
    .on({ Unknown })
    .do(async () => {})
    .build();

  // @ts-expect-error - Unknown is not in Counter's events
  void slice().withState(Counter).withProjection(BadProj);
}

// ── TEST 19: slice().withState(A).withState(B).withState(Proj).on().do() ───────────
{
  const Incremented = z.object({ amount: z.number() });
  const CounterProj = projection("counters")
    .on({ Incremented })
    .do(async () => {})
    .build();

  const _s = slice()
    .withState(Counter)
    .withState(Logger)
    .withProjection(CounterProj)
    .on("Incremented")
    .do(async (_event, _stream, app) => {
      // Handler receives Dispatcher<A_Counter & A_Logger>
      void app.do("increment", target, { by: 1 });
      void app.do("log", target, { message: "hello" });
      // @ts-expect-error - wrong action name
      void app.do("nonexistent", target, {});
      // @ts-expect-error - wrong payload for log
      void app.do("log", target, { by: 1 });
    })
    .void()
    .build();
}

// ── TEST 20: slice .on() event names constrained to slice events ────
{
  const _s = slice()
    .withState(Counter)
    // @ts-expect-error - "Logged" is not an event from Counter
    .on("Logged");
}

// ── TEST 21: slice .do() handler event data is typed ────────────────
{
  const _s = slice()
    .withState(Counter)
    .withState(Logger)
    .on("Incremented")
    .do(async (event) => {
      // Event data matches Incremented schema
      const _amt: number = event.data.amount;
      // @ts-expect-error - "message" is not on Incremented event
      event.data.message;
    })
    .void()
    .on("Logged")
    .do(async (event) => {
      // Event data matches Logged schema
      const _msg: string = event.data.message;
      // @ts-expect-error - "amount" is not on Logged event
      event.data.amount;
    })
    .void()
    .build();
}

// ── TEST 22: act+slice+projection — full composition ────────────────
{
  const Incremented = z.object({ amount: z.number() });
  const CounterProj = projection("counters")
    .on({ Incremented })
    .do(async () => {})
    .build();

  const CounterSlice = slice()
    .withState(Counter)
    .withProjection(CounterProj)
    .on("Incremented")
    .do(async (_event, _stream, app) => {
      void app.do("increment", target, { by: 1 });
    })
    .void()
    .build();

  const app = act().withSlice(CounterSlice).withState(Logger).build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
  // @ts-expect-error - wrong action
  void app.do("nonexistent", target, {});
  // @ts-expect-error - wrong payload
  void app.do("increment", target, { message: "wrong" });
}

// ── TEST 23: act .on() handler Dispatcher has all actions ───────────
{
  const CounterSlice = slice().withState(Counter).build();
  const _app = act()
    .withSlice(CounterSlice)
    .withState(Logger)
    .on("Incremented")
    .do(async (_event, _stream, app) => {
      // Dispatcher should see both Counter and Logger actions
      void app.do("increment", target, { by: 1 });
      void app.do("log", target, { message: "reacted" });
      // @ts-expect-error - wrong action name
      void app.do("nonexistent", target, {});
    })
    .void()
    .build();
}

// ── TEST 24: act .on() rejects unknown event names ──────────────────
{
  void act()
    .withState(Counter)
    // @ts-expect-error - "UnknownEvent" not in Counter events
    .on("UnknownEvent");
}

// ── TEST 25: projection handler gets typed event data ───────────────
{
  const Incremented = z.object({ amount: z.number() });
  const _proj = projection("counters")
    .on({ Incremented })
    .do(async (event) => {
      const _amt: number = event.data.amount;
      // @ts-expect-error - "message" is not on Incremented
      event.data.message;
    })
    .build();
}

// ── TEST 26: act+standalone-projection composition ──────────────────
{
  const Incremented = z.object({ amount: z.number() });
  const Logged = z.object({ message: z.string() });
  const MultiProj = projection("readmodel")
    .on({ Incremented })
    .do(async () => {})
    .on({ Logged })
    .do(async () => {})
    .build();

  // Both events exist in the app — should compile
  const app = act()
    .withState(Counter)
    .withState(Logger)
    .withProjection(MultiProj)
    .build();
  void app.do("increment", target, { by: 1 });
  void app.do("log", target, { message: "test" });
}
