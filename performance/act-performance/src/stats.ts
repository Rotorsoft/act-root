import { Drain, Schemas } from "@rotorsoft/act";
import Table from "cli-table3";

export interface ConvergenceState {
  streamCount: number;
  lastMatch: number;
  consecutiveMatches: number;
  convergedAt?: number;
  convergedTime?: number;
}

// Convergence tracking
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
const startTime = Date.now();

function checkConvergence(
  watermarks: number[],
  state: ConvergenceState,
  drainCount: number,
  eventCount: number,
  convergenceThreadhold: number
): void {
  state.streamCount = watermarks.length;
  if (state.convergedAt) return;

  const allMatchEventCount =
    watermarks.length && watermarks.every((w) => w === eventCount);
  const allMatchPrevious =
    watermarks.length &&
    state.lastMatch > 0 &&
    watermarks.every((w) => w === state.lastMatch);

  if (allMatchEventCount || allMatchPrevious) {
    const currentValue = allMatchEventCount ? eventCount : watermarks[0];
    if (state.lastMatch === currentValue) {
      state.consecutiveMatches++;
      if (state.consecutiveMatches >= convergenceThreadhold) {
        // converged!
        state.convergedAt = drainCount;
        state.convergedTime = Date.now() - startTime;
      }
    } else {
      state.consecutiveMatches = 1;
    }
    state.lastMatch = currentValue;
  } else {
    state.consecutiveMatches = 0;
    state.lastMatch = watermarks.length ? watermarks[0] : 0;
  }
}

export function updateStats<E extends Schemas>(
  drainCount: number,
  eventCount: number,
  drain: Drain<E>
): [ConvergenceState, ConvergenceState] {
  // this is an approximation
  const convergenceThreshold = Math.floor(drain.leased.length / 2);

  const lagging_watermarks = drain.acked
    .filter((acked) => acked.lagging)
    .map((acked) => acked.at)
    .sort((a, b) => a - b);
  checkConvergence(
    lagging_watermarks,
    lagging,
    drainCount,
    eventCount,
    convergenceThreshold
  );

  const leading_watermarks = drain.acked
    .filter((acked) => !acked.lagging)
    .map((acked) => acked.at)
    .sort((a, b) => a - b);
  checkConvergence(
    leading_watermarks,
    leading,
    drainCount,
    eventCount,
    convergenceThreshold
  );

  table.options.head = createTableHeaders(convergenceThreshold);

  table.length = 0;
  table.push([
    drainCount,
    eventCount,
    lagging_watermarks.join(", "),
    leading_watermarks.join(", "),
  ]);

  console.clear();
  console.log(table.toString());

  return [lagging, leading];
}

const createTableHeaders = (convergenceThreshold = 5) => [
  "drains",
  "events",
  `${lagging.streamCount} lagging ${lagging.convergedAt ? `(converged @${lagging.convergedAt})` : lagging.consecutiveMatches ? `(${lagging.consecutiveMatches}/${convergenceThreshold})` : ""}`,
  `${leading.streamCount} leading ${leading.convergedAt ? `(converged @${leading.convergedAt})` : leading.consecutiveMatches ? `(${leading.consecutiveMatches}/${convergenceThreshold})` : ""}`,
];

const table = new Table({
  head: createTableHeaders(),
  colAligns: ["center", "center", "center", "center"],
  colWidths: [8, 8, 50, 50],
  wordWrap: false,
  style: { compact: true, head: ["green"] },
});
