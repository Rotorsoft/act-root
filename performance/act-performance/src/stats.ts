import { Drain, Schemas } from "@rotorsoft/act";
import Table from "cli-table3";

// Types
export interface ConvergenceStatus {
  lagConverged: boolean;
  leadConverged: boolean;
  bothConverged: boolean;
  lagConvergedTime?: number;
  leadConvergedTime?: number;
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
const lagState: ConvergenceState = {
  convergedAt: 0,
  lastMatch: 0,
  consecutiveMatches: 0,
};
const leadState: ConvergenceState = {
  convergedAt: 0,
  lastMatch: 0,
  consecutiveMatches: 0,
};
const startTime = Date.now();
let lagConvergedTime: number | undefined;
let leadConvergedTime: number | undefined;

const createTableHeaders = (
  totalLag = 0,
  totalLead = 0,
  lagConverged = 0,
  leadConverged = 0,
  lagProgress = 0,
  leadProgress = 0,
  convergenceThreshold = 5
) => [
  "drains",
  "events",
  "streams",
  `${totalLag} lag streams ${lagConverged ? `(converged @${lagConverged})` : lagProgress ? `(${lagProgress}/${convergenceThreshold})` : ""}`,
  `${totalLead} lead streams ${leadConverged ? `(converged @${leadConverged})` : leadProgress ? `(${leadProgress}/${convergenceThreshold})` : ""}`,
];

const table = new Table({
  head: createTableHeaders(),
  colAligns: ["center", "center", "center", "center", "center"],
  colWidths: [10, 10, 10, 60, 60],
  wordWrap: false,
  style: { compact: true, head: ["green"] },
});

export interface ConvergenceStatus {
  lagConverged: boolean;
  leadConverged: boolean;
  bothConverged: boolean;
}

export function updateStats<E extends Schemas>(
  drainCount: number,
  eventCount: number,
  streams: Set<string>,
  lag_drained: Drain<E>,
  lead_drained: Drain<E>
): ConvergenceStatus {
  const convergenceThreshold = Math.max(
    lag_drained.leased.length,
    lead_drained.leased.length
  );

  const lag = lag_drained.acked
    .map((acked, index) => ({
      at: acked.at,
      incomplete: lag_drained.leased[index]?.at > acked.at,
    }))
    .sort((a, b) => a.at - b.at);

  const lead = lead_drained.acked
    .map((acked, index) => ({
      at: acked.at,
      incomplete: lead_drained.leased[index]?.at > acked.at,
    }))
    .sort((a, b) => a.at - b.at);

  const lagResult = checkConvergence(
    lag,
    lagState,
    drainCount,
    eventCount,
    convergenceThreshold
  );
  if (lagResult.convergedAt && !lagConvergedTime) {
    lagConvergedTime = Date.now() - startTime;
  }
  const leadResult = checkConvergence(
    lead,
    leadState,
    drainCount,
    eventCount,
    convergenceThreshold
  );
  if (leadResult.convergedAt && !leadConvergedTime) {
    leadConvergedTime = Date.now() - startTime;
  }

  // Update table headers if convergence status changed
  table.options.head = createTableHeaders(
    lag.length,
    lead.length,
    lagState.convergedAt,
    leadState.convergedAt,
    lagState.consecutiveMatches,
    leadState.consecutiveMatches,
    convergenceThreshold
  );

  table.length = 0;
  table.push([
    drainCount,
    eventCount,
    streams.size,
    lag
      .map((watermark) => `${watermark.at}${watermark.incomplete ? "." : ""}`)
      .join(", "),
    lead
      .map((watermark) => `${watermark.at}${watermark.incomplete ? "." : ""}`)
      .join(", "),
  ]);

  console.clear();
  console.log(table.toString());

  return {
    lagConverged: lagState.convergedAt > 0,
    leadConverged: leadState.convergedAt > 0,
    bothConverged: lagState.convergedAt > 0 && leadState.convergedAt > 0,
    lagConvergedTime,
    leadConvergedTime,
  };
}
