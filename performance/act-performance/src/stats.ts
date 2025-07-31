import { Drain, Schemas } from "@rotorsoft/act";
import Table from "cli-table3";

// Types
export interface ConvergenceStatus {
  converged: boolean;
  convergenceTime?: number;
}

interface ConvergenceState {
  convergedAt: number;
  lastMatch: number;
  consecutiveMatches: number;
}

interface ConvergenceResult {
  convergedAt: number;
  consecutiveMatches: number;
  lastMatch: number;
}

function checkConvergence(
  watermarks: { at: number; incomplete: boolean }[],
  state: ConvergenceState,
  drainCount: number,
  eventCount: number,
  convergenceThreadhold: number
): ConvergenceResult {
  if (state.convergedAt) return state;

  const allMatchEventCount =
    watermarks.length && watermarks.every((w) => w.at === eventCount);
  const allMatchPrevious =
    watermarks.length &&
    state.lastMatch > 0 &&
    watermarks.every((w) => w.at === state.lastMatch);

  if (allMatchEventCount || allMatchPrevious) {
    const currentValue = allMatchEventCount ? eventCount : watermarks[0].at;
    if (state.lastMatch === currentValue) {
      state.consecutiveMatches++;
      if (state.consecutiveMatches >= convergenceThreadhold) {
        state.convergedAt = drainCount;
      }
    } else {
      state.consecutiveMatches = 1;
    }
    state.lastMatch = currentValue;
  } else {
    state.consecutiveMatches = 0;
    state.lastMatch = watermarks.length ? watermarks[0].at : 0;
  }
  return state;
}

// Convergence tracking
const state: ConvergenceState = {
  convergedAt: 0,
  lastMatch: 0,
  consecutiveMatches: 0,
};
const startTime = Date.now();
let convergenceTime: number | undefined;

const createTableHeaders = (
  total = 0,
  converged = 0,
  progress = 0,
  convergenceThreshold = 5
) => [
  "drains",
  "events",
  "streams",
  `draining ${total} streams ${converged ? `(converged @${converged})` : progress ? `(${progress}/${convergenceThreshold})` : ""}`,
];

const table = new Table({
  head: createTableHeaders(),
  colAligns: ["center", "center", "center", "center"],
  colWidths: [8, 8, 10, 80],
  wordWrap: false,
  style: { compact: true, head: ["green"] },
});

export function updateStats<E extends Schemas>(
  drainCount: number,
  eventCount: number,
  streams: Set<string>,
  drain: Drain<E>
): ConvergenceStatus {
  const convergenceThreshold = Math.ceil(drain.leased.length / 2);

  const watermarks = drain.acked
    .map((acked, index) => ({
      at: acked.at,
      incomplete: drain.leased[index]?.at > acked.at,
    }))
    .sort((a, b) => a.at - b.at);

  const convergence = checkConvergence(
    watermarks,
    state,
    drainCount,
    eventCount,
    convergenceThreshold
  );
  if (convergence.convergedAt && !convergenceTime) {
    convergenceTime = Date.now() - startTime;
  }

  // Update table headers if convergence status changed
  table.options.head = createTableHeaders(
    watermarks.length,
    state.convergedAt,
    state.consecutiveMatches,
    convergenceThreshold
  );

  table.length = 0;
  table.push([
    drainCount,
    eventCount,
    streams.size,
    watermarks
      .map((watermark) => `${watermark.at}${watermark.incomplete ? "." : ""}`)
      .join(", "),
  ]);

  console.clear();
  console.log(table.toString());

  return {
    converged: state.convergedAt > 0,
    convergenceTime: convergenceTime,
  };
}
