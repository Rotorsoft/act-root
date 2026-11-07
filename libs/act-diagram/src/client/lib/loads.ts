/**
 * What an action's `.loads(...)` mean for its commit: a load that lists events
 * appends to that stream in the action's one commit, guarded by its version at
 * load; a load without events is a read and isn't guarded.
 */
import type { ActionNode, LoadNode } from "../types/index.js";

export const appending_loads = (action: ActionNode): LoadNode[] =>
  (action.loads ?? []).filter((l) => l.events.length > 0);

export const read_loads = (action: ActionNode): LoadNode[] =>
  (action.loads ?? []).filter((l) => l.events.length === 0);

/** The load that lists `event`, when the action appends it to a loaded stream. */
export const load_of = (
  action: ActionNode,
  event: string
): LoadNode | undefined => action.loads?.find((l) => l.events.includes(event));

/** A load by its state, with its name when that differs (one state loaded twice). */
export const load_label = (load: LoadNode): string =>
  load.name === load.state ? load.state : `${load.state} as "${load.name}"`;

/** The streams of the action's one commit, its own first; just its own without appending loads. */
export const commit_streams = (action: ActionNode, owner: string): string[] => [
  owner,
  ...appending_loads(action).map(load_label),
];

/** "one commit across 2 streams (Enrollment, Seats)", or undefined for a single-stream action. */
export const commit_summary = (
  action: ActionNode,
  owner: string
): string | undefined => {
  const streams = commit_streams(action, owner);
  return streams.length > 1
    ? `one commit across ${streams.length} streams (${streams.join(", ")})`
    : undefined;
};
