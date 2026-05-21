/**
 * `app.audit()` demo — operator's runbook in code form.
 *
 * Walks through every category the audit knows about, narrating
 * what each one detects and why an operator would care. For each
 * category we:
 *   1. seed an adversarial-but-realistic state in the store,
 *   2. run `app.audit([category])` against just that category,
 *   3. pretty-print the findings + the matching remediation.
 *
 * The numbers used here (5-event threshold, etc.) are deliberately
 * tiny so the demo runs in under a second. In production you'd lean
 * on the defaults (90-day idle, 10k restart, 500-snapshot drift) —
 * see `docs/docs/guides/auditing-a-store.md` for the full catalogue.
 *
 * Run: pnpm -F calculator dev:audit
 */
import { act, dispose, projection, sleep, state, store } from "@rotorsoft/act";
import type {
  AuditCategory,
  AuditFinding,
  AuditOptions,
} from "@rotorsoft/act/types";
import { z } from "zod";

// =====================================================================
// Domain
// =====================================================================
// `Tally` is a tiny aggregate with TWO event families:
//   - `Incremented` (deprecated) → `Incremented_v2`     (deprecation rule)
//   - `Cleared` (terminal in the operator's mental model)
// Plus `.snap()` so we can demonstrate restart/snapshot categories.

const IncrementedV1 = z.object({ by: z.number() });
const IncrementedV2 = z.object({ by: z.number(), reason: z.string() });
const Cleared = z.object({});

const Tally = state({
  Tally: z.object({ count: z.number() }),
})
  .init(() => ({ count: 0 }))
  .emits({
    Incremented: IncrementedV1, // v1 — deprecated by Incremented_v2
    Incremented_v2: IncrementedV2,
    Cleared,
  })
  .patch({
    Incremented: ({ data }, s) => ({ count: s.count + data.by }),
    Incremented_v2: ({ data }, s) => ({ count: s.count + data.by }),
    Cleared: () => ({ count: 0 }),
  })
  .on({ increment: z.object({ by: z.number(), reason: z.string() }) })
  .emit(({ by, reason }) => ["Incremented_v2", { by, reason }])
  .on({ clear: z.object({}) })
  .emit(() => ["Cleared", {}])
  .snap((s) => s.patches >= 5)
  .build();

// A projection that reacts to Incremented_v2 — so the registry has
// at least one routed event name. Anything else surfaced from the
// store that *isn't* routed becomes a routing-health finding.
const totals = projection("totals")
  .on({ Incremented_v2: IncrementedV2 })
  .do(async function trackTotals() {
    await Promise.resolve();
  })
  .build();

// =====================================================================
// Narration helpers
// =====================================================================

const META = { correlation: "demo-corr", causation: {} };
const ACTOR = { id: "demo", name: "Demo Operator" };

function header(category: string, description: string): void {
  console.log("");
  console.log("─".repeat(72));
  console.log(`  ${category}`);
  console.log("─".repeat(72));
  console.log(`  ${description}`);
  console.log("");
}

function describeFinding(f: AuditFinding): void {
  const { category: _c, ...rest } = f;
  console.log(`  · ${f.category}  ${JSON.stringify(rest)}`);
}

function remediation(text: string): void {
  console.log(`\n  → remediation: ${text}`);
}

// Hard-clear the in-memory store between scenarios — drop wipes
// events + streams; seed reinitialises the watermark machinery.
async function reset(): Promise<void> {
  await store().drop();
  await store().seed();
}

type AuditableApp = {
  audit: (
    cats?: AuditCategory[],
    opts?: AuditOptions
  ) => AsyncIterable<AuditFinding>;
};

async function collect(
  app: AuditableApp,
  category: AuditCategory,
  options?: AuditOptions
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for await (const f of app.audit([category], options)) findings.push(f);
  return findings;
}

// =====================================================================
// Demo — single app, reset store between sections.
// =====================================================================

async function main() {
  console.log("=====================================================");
  console.log("  app.audit() — walking through every category");
  console.log("=====================================================");
  console.log(
    "\nEach block seeds an adversarial fixture, runs one category\n" +
      "of the audit, and prints the findings + the remediation\n" +
      "the operator would apply."
  );

  // Build a single Act for the whole demo; reset() between sections.
  const app = act().withState(Tally).withProjection(totals).build();

  // -------------------------------------------------------------------
  // 1. SCHEMA
  // -------------------------------------------------------------------
  await reset();
  header(
    "schema",
    "Walks every event in the audit window, parses it against the\n" +
      "  Zod schema the registry currently declares for its name.\n" +
      "  Two failure modes:\n" +
      "    · unknown_event_name      — event sits on disk, registry has no entry\n" +
      "    · schema_validation_failed — name known, payload fails Zod"
  );
  await app.do(
    "increment",
    { stream: "tally-1", actor: ACTOR },
    { by: 1, reason: "manual" }
  );
  await store().commit(
    "tally-1",
    [{ name: "Vanished", data: { gone: true } }],
    META
  );
  await store().commit(
    "tally-2",
    [{ name: "Incremented_v2", data: { by: 5 } }], // missing `reason`
    META
  );
  for (const f of await collect(app, "schema")) describeFinding(f);
  remediation(
    "fix the data model — version the event, update reducers, or close()\n" +
      "    the poisoned streams"
  );

  // -------------------------------------------------------------------
  // 2. DEPRECATED-LOAD
  // -------------------------------------------------------------------
  await reset();
  header(
    "deprecated-load",
    "Workspace-wide event-name histogram classified by the `_v<n>`\n" +
      "  rule. Surfaces deprecated families whose share of the total\n" +
      "  store is ≥ the threshold, with the top stream carriers."
  );
  // 8 legacy events across 2 streams + 2 current events. 80% legacy.
  for (const s of ["tally-a", "tally-b"]) {
    for (let i = 0; i < 4; i++) {
      await store().commit(s, [{ name: "Incremented", data: { by: 1 } }], META);
    }
  }
  await store().commit(
    "tally-a",
    [{ name: "Incremented_v2", data: { by: 1, reason: "migrated" } }],
    META
  );
  await store().commit(
    "tally-b",
    [{ name: "Incremented_v2", data: { by: 1, reason: "migrated" } }],
    META
  );
  for (const f of await collect(app, "deprecated-load", {
    thresholds: { deprecated_min: 0.1 },
  })) {
    describeFinding(f);
  }
  remediation(
    "app.close([{ stream }, …]) on the heaviest carriers —\n" +
      "    the deprecation already happened in code; this surfaces the on-disk rump"
  );

  // -------------------------------------------------------------------
  // 3. CLOSE-CANDIDATE (terminal + idle)
  // -------------------------------------------------------------------
  await reset();
  header(
    "close-candidate",
    "Streams ripe for app.close(...). Two flavours:\n" +
      "    · terminal — head event is in the operator's terminal list\n" +
      "    · idle     — head event is older than idle_days\n" +
      "  Each finding carries restart_supported so the operator picks\n" +
      "  between close() (full tombstone) and close({restart:true})."
  );
  await app.do(
    "increment",
    { stream: "active", actor: ACTOR },
    { by: 7, reason: "today" }
  );
  await app.do(
    "increment",
    { stream: "shipped", actor: ACTOR },
    { by: 1, reason: "open" }
  );
  await app.do("clear", { stream: "shipped", actor: ACTOR }, {});
  await app.do(
    "increment",
    { stream: "old", actor: ACTOR },
    { by: 1, reason: "ancient" }
  );
  // Backdate the head event on `old` to simulate stopped traffic.
  const eventsCC = (
    store() as unknown as {
      _events: Array<{ stream: string; created: Date }>;
    }
  )._events;
  const old100d = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  for (const e of eventsCC) {
    if (e.stream === "old") e.created = old100d;
  }
  await sleep(20);
  for (const f of await collect(app, "close-candidate", {
    thresholds: { idle_days: 90, terminal_events: ["Cleared"] },
  })) {
    describeFinding(f);
  }
  remediation(
    "app.close([{ stream }])               — tombstone the stream\n" +
      "    app.close([{ stream, restart: true }]) — truncate + seed snapshot"
  );

  // -------------------------------------------------------------------
  // 4. RESTART-CANDIDATE
  // -------------------------------------------------------------------
  await reset();
  header(
    "restart-candidate",
    "Streams above the event-count threshold whose owning state has\n" +
      "  .snap() declared. Restart shrinks the working set without\n" +
      "  losing state — replay through .snap(), seed a snapshot,\n" +
      "  tombstone history."
  );
  for (let i = 0; i < 12; i++) {
    await app.do(
      "increment",
      { stream: "big-tally", actor: ACTOR },
      { by: i, reason: "load-test" }
    );
  }
  for (const f of await collect(app, "restart-candidate", {
    thresholds: { restart_min: 10 },
  })) {
    describeFinding(f);
  }
  remediation("app.close([{ stream, restart: true }])");

  // -------------------------------------------------------------------
  // 5. REACTION-HEALTH (blocked + near-block)
  // -------------------------------------------------------------------
  await reset();
  header(
    "reaction-health",
    "Surfaces blocked / near-block / stuck-backoff streams via the\n" +
      "  subscription table. Three sub-statuses:\n" +
      "    · blocked       — drain gave up; investigate then unblock()\n" +
      "    · near-block    — retry ≥ threshold; one more failure tombstones\n" +
      "    · stuck-backoff — lease expired but leased_by still set"
  );
  await app.do(
    "increment",
    { stream: "blocked-stream", actor: ACTOR },
    { by: 1, reason: "x" }
  );
  await store().subscribe([
    { stream: "blocked-stream", source: "blocked-stream" },
  ]);
  const claimed = await store().claim(1, 1, "demo", 60_000);
  if (claimed.length > 0) {
    await store().block([
      {
        ...claimed[0],
        at: 1,
        error: "downstream API rejected payload",
      },
    ]);
  }
  await app.do(
    "increment",
    { stream: "flaky-stream", actor: ACTOR },
    { by: 1, reason: "x" }
  );
  await store().subscribe([{ stream: "flaky-stream", source: "flaky-stream" }]);
  const flakyMap = (
    store() as unknown as { _streams: Map<string, { _retry: number }> }
  )._streams;
  const flaky = flakyMap.get("flaky-stream");
  if (flaky) flaky._retry = 4;
  for (const f of await collect(app, "reaction-health", {
    thresholds: { near_block: 3 },
  })) {
    describeFinding(f);
  }
  remediation(
    "app.unblock(stream)   — resume after fixing the underlying issue\n" +
      "    app.reset(stream)     — for projection rebuilds (wipes watermark)\n" +
      "    stuck-backoff: investigate the crashed worker before either"
  );

  // -------------------------------------------------------------------
  // 6. SNAPSHOT-DRIFT
  // -------------------------------------------------------------------
  await reset();
  header(
    "snapshot-drift",
    "Streams that have accumulated many events past their last\n" +
      "  __snapshot__ marker. Cold loads pay full replay cost —\n" +
      "  painful for hot read paths."
  );
  // Direct store.commit bypasses .snap() so we can accumulate events
  // past the last snapshot — same shape the audit cares about.
  for (let i = 0; i < 15; i++) {
    await store().commit(
      "drifty",
      [{ name: "Incremented_v2", data: { by: 1, reason: "no-snap" } }],
      META
    );
  }
  for (const f of await collect(app, "snapshot-drift", {
    thresholds: { drift_min: 10 },
  })) {
    describeFinding(f);
  }
  remediation(
    "load({ snap: true }) once during off-peak to seed a snapshot,\n" +
      "    or tune the state's .snap() predicate to fire more often"
  );

  // -------------------------------------------------------------------
  // 7. ROUTING-HEALTH (unknown-lane + unrouted)
  // -------------------------------------------------------------------
  await reset();
  header(
    "routing-health",
    "Subscription rows whose lane isn't in the running registry\n" +
      "  (unknown-lane), plus event names that no reaction consumes\n" +
      "  (unrouted). Lanes are restart-driven — renaming a lane in\n" +
      "  withLane() leaves existing streams pinned to the old name."
  );
  await app.do(
    "increment",
    { stream: "homeless", actor: ACTOR },
    { by: 1, reason: "abandoned-lane" }
  );
  await store().subscribe([
    { stream: "homeless", source: "homeless", lane: "deprecated-lane" },
  ]);
  await store().commit(
    "rogue",
    [{ name: "Incremented", data: { by: 99 } }], // legacy event isn't routed
    META
  );
  for (const f of await collect(app, "routing-health")) describeFinding(f);
  remediation(
    "unknown-lane → re-deploy with the lane redeclared, or re-subscribe\n" +
      "    unrouted     → add the reaction, or accept it's a pure-projection event"
  );

  // -------------------------------------------------------------------
  // 8. CORRELATION-GAPS
  // -------------------------------------------------------------------
  await reset();
  header(
    "correlation-gaps",
    "Events whose meta.causation.event.id references a parent that\n" +
      "  isn't in the audit window. Usually an upstream correlator\n" +
      "  writing dangling parent references."
  );
  await store().commit(
    "ok-stream",
    [{ name: "Incremented_v2", data: { by: 1, reason: "ok" } }],
    META
  );
  await store().commit(
    "orphan-stream",
    [{ name: "Incremented_v2", data: { by: 1, reason: "orphan" } }],
    {
      correlation: "demo-corr",
      causation: { event: { id: 9999, stream: "fake", name: "fake" } },
    } as unknown as { correlation: string; causation: object }
  );
  for (const f of await collect(app, "correlation-gaps")) describeFinding(f);
  remediation("fix the upstream correlator misconfig writing dangling refs");

  // -------------------------------------------------------------------
  // 9. CLOCK-ANOMALIES
  // -------------------------------------------------------------------
  await reset();
  header(
    "clock-anomalies",
    "Future-dated created timestamps + per-stream out-of-order\n" +
      "  commits. Clock skew, NTP drift, container clock-jumps.\n" +
      "  Framework can't act on these — operator escalates to infra."
  );
  await app.do(
    "increment",
    { stream: "skewed", actor: ACTOR },
    { by: 1, reason: "first" }
  );
  await app.do(
    "increment",
    { stream: "skewed", actor: ACTOR },
    { by: 2, reason: "second" }
  );
  const eventsCA = (
    store() as unknown as {
      _events: Array<{ stream: string; created: Date }>;
    }
  )._events;
  const skewed = eventsCA.filter((e) => e.stream === "skewed");
  if (skewed.length >= 2) {
    skewed[0].created = new Date(Date.now() + 60 * 60 * 1000); // future
    skewed[1].created = new Date(Date.now() - 60 * 60 * 1000); // backward
  }
  for (const f of await collect(app, "clock-anomalies")) describeFinding(f);
  remediation(
    "infra: check NTP / container clock sync; usually not a framework problem"
  );

  // -------------------------------------------------------------------
  // Bonus: walk ALL categories in one pass (single-scan multiplex)
  // -------------------------------------------------------------------
  await reset();
  console.log("");
  console.log("─".repeat(72));
  console.log("  app.audit()   (no args → every category at once)");
  console.log("─".repeat(72));
  console.log(
    "\n  Three shared scans (events / streams / stats) drive every\n" +
      "  category in a single pass — adding categories doesn't add\n" +
      "  table walks. Seed one tiny finding per category and let\n" +
      "  the dispatcher route each row to the interested passes.\n"
  );
  await store().commit(
    "all-1",
    [{ name: "Incremented", data: { by: 1 } }],
    META
  );
  await store().commit("all-1", [{ name: "Mystery", data: {} }], META);
  await app.do(
    "increment",
    { stream: "all-2", actor: ACTOR },
    { by: 1, reason: "current" }
  );
  let count = 0;
  for await (const f of app.audit()) {
    count++;
    console.log(`  [${count}] ${f.category}`);
  }
  console.log(`\n  ${count} findings across all categories.`);

  console.log("\n=====================================================");
  console.log("  Done. See docs/docs/guides/auditing-a-store.md for");
  console.log("  the full threshold catalogue and CI/cron recipes.");
  console.log("=====================================================");

  await dispose()();
}

void main();
