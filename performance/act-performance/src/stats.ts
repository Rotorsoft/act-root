import type { Drain, Schemas } from "@rotorsoft/act";
import Table from "cli-table3";

/**
 * Convergence telemetry exposed to the caller.
 *
 * The example tracks lagging vs leading as two independent counters
 * for *educational* purposes — `acked.lagging` is a per-cycle frontier
 * property (which side of `claim()` pulled this stream), not a stream
 * identity. A given projection bucket can flip frontiers across cycles
 * as its watermark advances. The real "is everything done?" signal
 * lives in `streamsConverged / streamsKnown` below.
 *
 * @property streamCount    - Known streams touched on this frontier.
 * @property lastMatch      - Most recent watermark seen on this frontier.
 * @property consecutiveMatches - Cycles in a row with no movement (heuristic).
 * @property convergedAt    - Drain cycle at which we declared converged.
 * @property convergedTime  - Wall-clock ms from start to convergence.
 */
export interface ConvergenceState {
  streamCount: number;
  lastMatch: number;
  consecutiveMatches: number;
  convergedAt?: number;
  convergedTime?: number;
}

// Per-frontier state. Reset on first observation.
const lagging: ConvergenceState = {
  streamCount: 0,
  lastMatch: 0,
  consecutiveMatches: 0,
};
const leading: ConvergenceState = {
  streamCount: 0,
  lastMatch: 0,
  consecutiveMatches: 0,
};

// Per-stream watermark tracking. The honest convergence signal: every
// known projection stream has watermark == maxWatermarkObserved for
// CONVERGENCE_STABLE_CYCLES drains in a row.
const watermarks = new Map<string, number>();
const CONVERGENCE_STABLE_CYCLES = 5;
let stableCycles = 0;
let convergedDrainCount = 0;
let convergedTime = 0;
const startTime = Date.now();

// Exponential moving average of the adaptive lagging/leading split,
// for display only. The framework owns its own ratio internally — we
// reconstruct an observable hint from per-cycle claim counts.
let observedSplit = 0.5;
const SPLIT_EMA_ALPHA = 0.3;

function summarize(values: number[]): string {
  if (values.length === 0) return "—";
  const min = values[0];
  const max = values[values.length - 1];
  const gap = max - min;
  return values.length === 1 ? `${min}` : `${min}..${max}  gap=${gap}`;
}

type Bucket = {
  lane: string;
  frontier: "lagging" | "leading";
  leased: number;
  fetchedEvents: number;
  ackedStreams: number;
  watermarks: number[];
};

// Group drain results by (lane, frontier). `lane` lives on the lease
// (ACT-1103); `frontier` is `lagging`. Both are independent dimensions
// — the same lane can have streams on both frontiers, and a single
// frontier can host work from multiple lanes. `Fetch` entries don't
// carry the lane, so we resolve it via a stream→lane lookup built
// from the leased entries of this same cycle.
function bucketize<E extends Schemas>(drain: Drain<E>): Bucket[] {
  const laneByStream = new Map<string, string>();
  for (const l of drain.leased) laneByStream.set(l.stream, l.lane ?? "default");

  const map = new Map<string, Bucket>();
  const get = (lane: string, frontier: "lagging" | "leading") => {
    const k = `${lane}|${frontier}`;
    let b = map.get(k);
    if (!b) {
      b = {
        lane,
        frontier,
        leased: 0,
        fetchedEvents: 0,
        ackedStreams: 0,
        watermarks: [],
      };
      map.set(k, b);
    }
    return b;
  };
  for (const l of drain.leased) {
    get(l.lane ?? "default", l.lagging ? "lagging" : "leading").leased += 1;
  }
  for (const f of drain.fetched) {
    const lane = laneByStream.get(f.stream) ?? "default";
    get(lane, f.lagging ? "lagging" : "leading").fetchedEvents +=
      f.events.length;
  }
  for (const a of drain.acked) {
    const b = get(a.lane ?? "default", a.lagging ? "lagging" : "leading");
    b.ackedStreams += 1;
    b.watermarks.push(a.at);
  }
  return [...map.values()].sort((x, y) =>
    x.lane === y.lane
      ? x.frontier.localeCompare(y.frontier)
      : x.lane.localeCompare(y.lane)
  );
}

export function updateStats<E extends Schemas>(
  drainCount: number,
  eventCount: number,
  drain: Drain<E>
): [ConvergenceState, ConvergenceState] {
  // --- This cycle's frontier split (what claim() actually pulled) ---
  const leasedLagging = drain.leased.filter((l) => l.lagging).length;
  const leasedLeading = drain.leased.length - leasedLagging;
  const ackedLagging = drain.acked.filter((a) => a.lagging);
  const ackedLeading = drain.acked.filter((a) => !a.lagging);

  // Per-(lane, frontier) buckets for the rendered table.
  const buckets = bucketize(drain);

  // Watermarks of streams successfully acked this cycle (sorted for range).
  const laggingWatermarks = ackedLagging.map((a) => a.at).sort((a, b) => a - b);
  const leadingWatermarks = ackedLeading.map((a) => a.at).sort((a, b) => a - b);

  // Observable split hint: ratio of lagging claim to total claim,
  // smoothed across cycles so the display doesn't flicker.
  if (drain.leased.length > 0) {
    const cycleSplit = leasedLagging / drain.leased.length;
    observedSplit =
      SPLIT_EMA_ALPHA * cycleSplit + (1 - SPLIT_EMA_ALPHA) * observedSplit;
  }

  // --- Per-stream watermark map (honest convergence) ---
  for (const acked of drain.acked) {
    const prev = watermarks.get(acked.stream) ?? -1;
    if (acked.at > prev) watermarks.set(acked.stream, acked.at);
  }
  const allWms = [...watermarks.values()];
  const maxWatermark = allWms.length > 0 ? Math.max(...allWms) : 0;
  const streamsConverged = allWms.filter((w) => w === maxWatermark).length;
  const streamsKnown = watermarks.size;

  // Real convergence: every known stream at max for N cycles in a row.
  // We additionally require the maxWatermark to have caught up to
  // eventCount — otherwise we'd declare convergence mid-load.
  const allAtMax =
    streamsKnown > 0 &&
    streamsConverged === streamsKnown &&
    maxWatermark >= eventCount;

  if (allAtMax) {
    stableCycles++;
    if (stableCycles >= CONVERGENCE_STABLE_CYCLES && !convergedDrainCount) {
      convergedDrainCount = drainCount;
      convergedTime = Date.now() - startTime;
    }
  } else {
    stableCycles = 0;
  }

  // Surface per-frontier counts in the legacy state objects for
  // backwards compat with callers that read `.convergedAt`. The
  // honest converge signal lives in `convergedDrainCount` and is
  // mirrored into BOTH state objects below.
  lagging.streamCount = leasedLagging;
  lagging.lastMatch = laggingWatermarks.at(-1) ?? lagging.lastMatch;
  lagging.consecutiveMatches = stableCycles;
  leading.streamCount = leasedLeading;
  leading.lastMatch = leadingWatermarks.at(-1) ?? leading.lastMatch;
  leading.consecutiveMatches = stableCycles;
  if (convergedDrainCount) {
    lagging.convergedAt = convergedDrainCount;
    lagging.convergedTime = convergedTime;
    leading.convergedAt = convergedDrainCount;
    leading.convergedTime = convergedTime;
  }

  // --- Render ---
  const splitPct = (n: number) => `${Math.round(n * 100)}%`;
  const header = [
    `Drain #${drainCount}`,
    `committed=${eventCount}`,
    `budget split (observed): ${splitPct(observedSplit)} lagging / ${splitPct(1 - observedSplit)} leading`,
  ].join("  |  ");

  table.length = 0;
  if (buckets.length === 0) {
    // Empty cycle — show one neutral row rather than an empty grid.
    table.push(["—", "—", 0, "0 evts / 0 streams", "—"]);
  } else {
    for (const b of buckets) {
      const wms = [...b.watermarks].sort((a, b) => a - b);
      table.push([
        b.lane,
        b.frontier,
        b.leased,
        `${b.fetchedEvents} evts / ${b.ackedStreams} streams`,
        summarize(wms),
      ]);
    }
  }

  const convergenceLine = convergedDrainCount
    ? `✓ Converged at drain #${convergedDrainCount} after ${(convergedTime / 1000).toFixed(2)}s`
    : `Progress: ${streamsConverged}/${streamsKnown} streams caught up to wm=${maxWatermark} (target=${eventCount})  |  ${stableCycles}/${CONVERGENCE_STABLE_CYCLES} stable cycles`;

  console.clear();
  console.log(header);
  console.log(table.toString());
  console.log(convergenceLine);
  if (drain.blocked.length > 0) {
    console.log(
      `⚠ blocked: ${drain.blocked.length} (${drain.blocked.map((b) => b.stream).join(", ")})`
    );
  }

  return [lagging, leading];
}

const table = new Table({
  head: ["lane", "frontier", "claimed", "acked (this cycle)", "watermarks"],
  colAligns: ["left", "left", "right", "left", "left"],
  colWidths: [12, 10, 9, 26, 26],
  wordWrap: false,
  style: { compact: true, head: ["green"] },
});
