/**
 * Cross-process commit→reaction latency report.
 *
 * Two `PostgresStore` instances on the same docker DB simulate two
 * processes: a *writer* commits events, a *reader* runs reactions. We
 * record commit→reaction latency for each event and report p50/p95/p99
 * for two modes:
 *
 *   - **notify mode**: the reader builds an `Act` orchestrator against
 *     its own store, so `Store.notify` auto-wires and `settle()` wakes
 *     immediately on the writer's NOTIFY (no polling delay).
 *   - **polling mode**: same orchestrator, with notify subscription
 *     released and reactions driven by an explicit
 *     `setInterval(correlate→drain, …)` pump.
 *
 * Filename uses `.bench.ts` so the default `vitest run` include pattern
 * (`*.{test,spec}.ts`) skips it — the docker round-trip cost doesn't
 * inflate ordinary CI runtime. Numbers feed `PERFORMANCE.md`.
 *
 * Run: `pnpm -F @rotorsoft/act-pg exec vitest run --config vitest.bench.config.ts`
 */
import {
  act,
  dispose,
  type ReactionHandler,
  state,
  store,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";
import { PostgresStore } from "../src/postgres-store.js";

const PORT = 5431;
const SCHEMA = "schema_notify_bench";
const TABLE = "notify_bench";
const ACTOR = { id: "bench", name: "bench" };
const POLL_INTERVAL_MS = 50;
const COMMITS = 30;
const COMMIT_GAP_MS = 30;

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Tick: ZodEmpty })
  .patch({ Tick: (_, s) => ({ count: s.count + 1 }) })
  .on({ tick: ZodEmpty })
  .emit(() => ["Tick", {}])
  .build();

type LatencyRecorder = {
  start: (id: string) => void;
  finish: (id: string) => void;
  drain: () => number[];
};

function recorder(): LatencyRecorder {
  const starts = new Map<string, number>();
  const samples: number[] = [];
  return {
    start: (id) => starts.set(id, performance.now()),
    finish: (id) => {
      const t = starts.get(id);
      if (t !== undefined) {
        samples.push(performance.now() - t);
        starts.delete(id);
      }
    },
    drain: () => samples.splice(0),
  };
}

function pct(samples: number[], p: number) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  ];
}

async function setupReader(notifyEnabled: boolean, rec: LatencyRecorder) {
  // notify path requires the store to opt in on both sides; the
  // polling baseline still uses notify=true on the writer so the
  // comparison isolates the wakeup mechanism (LISTEN vs poll), not
  // whether NOTIFYs are emitted.
  store(
    new PostgresStore({
      port: PORT,
      schema: SCHEMA,
      table: TABLE,
      notify: true,
    })
  );
  await store().drop();
  await store().seed();

  async function handler(event: { meta: { correlation: string } }) {
    rec.finish(event.meta.correlation);
  }

  const reader = act()
    .withState(Counter)
    .on("Tick")
    .do(handler as ReactionHandler<{ Tick: Record<string, never> }, "Tick">)
    .to((e) => ({ source: e.stream, target: `proj-${e.stream}` }))
    .build();

  let pollTimer: NodeJS.Timeout | undefined;
  if (!notifyEnabled) {
    // Tear down the auto-wired notify subscription and drive reactions
    // with an explicit correlate→drain pump — the classic poll-based
    // deployment shape. Avoid `settle()` here because its debounce
    // coalesces rapid schedules and would mask the polling-only
    // baseline we want to measure.
    const disposer = await (
      reader as unknown as {
        _notify_disposer: Promise<(() => void | Promise<void>) | undefined>;
      }
    )._notify_disposer;
    if (disposer) await disposer();
    pollTimer = setInterval(async () => {
      try {
        await reader.correlate({ limit: 100 });
        await reader.drain({ streamLimit: 50, eventLimit: 100 });
      } catch {
        // best-effort — pool may close mid-flight at teardown
      }
    }, POLL_INTERVAL_MS);
  } else {
    reader.on("notified", () => reader.settle({ debounceMs: 0 }));
  }

  return { reader, pollTimer };
}

async function runScenario(
  prefix: string,
  notifyEnabled: boolean
): Promise<number[]> {
  const rec = recorder();
  const { reader, pollTimer } = await setupReader(notifyEnabled, rec);
  const writer = new PostgresStore({
    port: PORT,
    schema: SCHEMA,
    table: TABLE,
    notify: true,
  });

  try {
    for (let i = 0; i < COMMITS; i++) {
      const id = `${prefix}-${i}`;
      rec.start(id);
      await writer.commit("stream-x", [{ name: "Tick", data: {} }], {
        correlation: id,
        causation: {
          action: { stream: "stream-x", name: "tick", actor: ACTOR },
        },
      });
      await new Promise((r) => setTimeout(r, COMMIT_GAP_MS));
    }
    // Allow trailing reactions to drain. Polling needs more headroom
    // because each correlate→drain pass fires at most every
    // POLL_INTERVAL_MS.
    await new Promise((r) =>
      setTimeout(r, notifyEnabled ? 500 : POLL_INTERVAL_MS * 8)
    );
    return rec.drain();
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    reader.stop_correlations();
    reader.stop_settling();
    await writer.dispose();
    await dispose()();
  }
}

describe("ACT-101 cross-process commit→reaction latency", () => {
  it("p50/p95/p99 — notify vs polling", async () => {
    const notifySamples = await runScenario("notify", true);
    const pollSamples = await runScenario("poll", false);

    const notifyKey = `notify (n=${notifySamples.length})`;
    const pollKey = `polling (n=${pollSamples.length})`;
    // eslint-disable-next-line no-console
    console.log("\n=== ACT-101 cross-process commit→reaction latency ===");
    // eslint-disable-next-line no-console
    console.table({
      [notifyKey]: {
        p50: pct(notifySamples, 50).toFixed(1) + " ms",
        p95: pct(notifySamples, 95).toFixed(1) + " ms",
        p99: pct(notifySamples, 99).toFixed(1) + " ms",
      },
      [pollKey]: {
        p50: pct(pollSamples, 50).toFixed(1) + " ms",
        p95: pct(pollSamples, 95).toFixed(1) + " ms",
        p99: pct(pollSamples, 99).toFixed(1) + " ms",
      },
    });
    // The notify path SHOULD be meaningfully faster at p99 — assert
    // a permissive bound so the report doubles as a regression guard.
    expect(pct(notifySamples, 99)).toBeLessThan(pct(pollSamples, 99));
  }, 60_000);
});
