import Table from "cli-table3";

// Types
export interface ConvergenceStatus {
  lagConverged: boolean;
  leadConverged: boolean;
  bothConverged: boolean;
  lagConvergedTime?: number;
  leadConvergedTime?: number;
}

// Constants
export const CONVERGENCE_THRESHOLD = 5; // number of consecutive matching drains needed

// Convergence tracking
let lagConvergedAt = 0;
let leadConvergedAt = 0;
let lastLagMatch = 0;
let lastLeadMatch = 0;
let consecutiveLagMatches = 0;
let consecutiveLeadMatches = 0;
const startTime = Date.now();
let lagConvergedTime: number | undefined;
let leadConvergedTime: number | undefined;

const createTableHeaders = (
  lagConverged = 0,
  leadConverged = 0,
  lagProgress = 0,
  leadProgress = 0
) => [
  "drains",
  "events",
  "streams",
  `lag ${lagConverged ? `(converged @${lagConverged})` : lagProgress ? `(${lagProgress}/${CONVERGENCE_THRESHOLD})` : ""}`,
  `lead ${leadConverged ? `(converged @${leadConverged})` : leadProgress ? `(${leadProgress}/${CONVERGENCE_THRESHOLD})` : ""}`,
];

const table = new Table({
  head: createTableHeaders(),
  colAligns: ["center", "center", "center", "center", "center"],
  colWidths: [10, 10, 10, 30, 50],
  wordWrap: false,
  style: { compact: true, head: ["green"] },
});

export interface ConvergenceStatus {
  lagConverged: boolean;
  leadConverged: boolean;
  bothConverged: boolean;
}

export function updateStats(
  drainCount: number,
  eventCount: number,
  streams: Set<string>,
  lag: number[],
  lead: number[]
): ConvergenceStatus {
  // Check lag convergence
  if (!lagConvergedAt) {
    const allLagMatch = lag.every((at) => at === eventCount);
    if (allLagMatch) {
      if (lastLagMatch === eventCount) {
        consecutiveLagMatches++;
        if (consecutiveLagMatches >= CONVERGENCE_THRESHOLD) {
          lagConvergedAt = drainCount;
          lagConvergedTime = Date.now() - startTime;
        }
      } else {
        consecutiveLagMatches = 1;
      }
      lastLagMatch = eventCount;
    } else {
      consecutiveLagMatches = 0;
      lastLagMatch = 0;
    }
  }

  // Check lead convergence
  if (!leadConvergedAt) {
    const allLeadMatch = lead.every((at) => at === eventCount);
    if (allLeadMatch) {
      if (lastLeadMatch === eventCount) {
        consecutiveLeadMatches++;
        if (consecutiveLeadMatches >= CONVERGENCE_THRESHOLD) {
          leadConvergedAt = drainCount;
          leadConvergedTime = Date.now() - startTime;
        }
      } else {
        consecutiveLeadMatches = 1;
      }
      lastLeadMatch = eventCount;
    } else {
      consecutiveLeadMatches = 0;
      lastLeadMatch = 0;
    }
  }

  // Update table headers if convergence status changed
  table.options.head = createTableHeaders(
    lagConvergedAt,
    leadConvergedAt,
    consecutiveLagMatches,
    consecutiveLeadMatches
  );

  table.length = 0;
  table.push([
    drainCount,
    eventCount,
    streams.size,
    lag.toString(),
    lead.toString(),
  ]);

  console.clear();
  console.log(table.toString());

  return {
    lagConverged: lagConvergedAt > 0,
    leadConverged: leadConvergedAt > 0,
    bothConverged: lagConvergedAt > 0 && leadConvergedAt > 0,
    lagConvergedTime,
    leadConvergedTime,
  };
}
