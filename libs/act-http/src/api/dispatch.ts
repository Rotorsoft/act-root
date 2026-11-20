import type { Actor } from "@rotorsoft/act";
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import type { ApiError } from "./errors.js";
import { withIdempotency } from "./idempotency.js";
import { track_in_flight } from "./in-flight.js";
import type { ActionSelection, ActSurface, StreamPatterns } from "./types.js";

// The generators import these from here; their home is `./types.js`.
export type {
  ActionInput,
  ActionResult,
  ActionSelection,
  ActSurface,
  AddressedActions,
  AppActions,
  AppState,
  AppStateNames,
  ResolverArgs,
  SelectedActions,
  StreamPatterns,
} from "./types.js";

/** Whether `stream` matches a state's pattern; a state without one takes any. */
export const matches_stream = (
  pattern: RegExp | ((stream: string) => boolean) | undefined,
  stream: string
): boolean =>
  !pattern ||
  (pattern instanceof RegExp ? pattern.test(stream) : pattern(stream));

/**
 * Whether a subscription to `state` may open `stream`: it matches the
 * state's pattern, or, for a state without one, no other state's pattern
 * claims it, so another state's stream never arrives typed as this one.
 */
export const is_stream_of = (
  state: string,
  stream: string,
  patterns:
    | Readonly<
        Record<string, RegExp | ((stream: string) => boolean) | undefined>
      >
    | undefined
): boolean => {
  const own = patterns?.[state];
  if (own) return matches_stream(own, stream);
  return !Object.entries(patterns ?? {}).some(
    ([name, pattern]) =>
      name !== state && pattern && matches_stream(pattern, stream)
  );
};

/**
 * The stream patterns of the states `app`'s actions belong to, by action
 * name, and refuses at generation a state that neither `patterns` nor a
 * `stream` resolver covers, or a pattern for a state the app doesn't have.
 */
export function stream_patterns(
  app: Pick<ActSurface, "registry">,
  patterns: StreamPatterns<unknown> | undefined,
  has_resolver: boolean,
  transport: string
): Map<string, (stream: string) => boolean> {
  const by_action = new Map<string, (stream: string) => boolean>();
  const states = new Set<string>();
  const uncovered = new Set<string>();
  for (const [action, state] of Object.entries(app.registry.actions)) {
    states.add(state.name);
    const pattern = patterns?.[state.name];
    if (pattern) by_action.set(action, (s) => matches_stream(pattern, s));
    else if (!has_resolver) uncovered.add(state.name);
  }
  const unknown = Object.keys(patterns ?? {}).filter((n) => !states.has(n));
  if (unknown.length)
    throw new Error(
      `${transport}: \`streams\` names ${unknown.map((n) => `"${n}"`).join(", ")}, which the app doesn't register.`
    );
  if (uncovered.size)
    throw new Error(
      `${transport}: no stream for ${[...uncovered].map((n) => `"${n}"`).join(", ")}: list the state in \`streams\`, or pass a \`stream\` resolver.`
    );
  return by_action;
}

/**
 * The registry's actions a generator emits under `selection`, as
 * `[name, state]` entries. Refuses a selection that names both lists, or an
 * action the registry doesn't have, so a typo can't leave a route mounted.
 */
export function selected_actions(
  app: Pick<ActSurface, "registry">,
  selection: ActionSelection<unknown> | undefined,
  transport: string
): [string, ActSurface["registry"]["actions"][string]][] {
  const entries = Object.entries(app.registry.actions);
  if (!selection) return entries;
  const { include, exclude } = selection as {
    include?: readonly string[];
    exclude?: readonly string[];
  };
  if (include && exclude)
    throw new Error(
      `${transport}: pass \`actions.include\` or \`actions.exclude\`, not both.`
    );
  const names = include ?? exclude ?? [];
  const unknown = names.filter((name) => !(name in app.registry.actions));
  if (unknown.length)
    throw new Error(
      `${transport}: \`actions\` names ${unknown.map((n) => `"${n}"`).join(", ")}, which the app doesn't register.`
    );
  const listed = new Set(names);
  return entries.filter(([name]) => listed.has(name) === !!include);
}

/** The target resolvers a generated transport takes, over its own context. */
type TargetResolvers<C> = {
  readonly stream?: (
    action_name: string,
    input: unknown,
    ctx: C
  ) => string | Promise<string>;
  readonly expectedVersion?: (
    action_name: string,
    input: unknown,
    ctx: C
  ) => number | undefined | Promise<number | undefined>;
};

/** A refused call: its status and the {@link ApiError} each transport sends. */
export type Refused = {
  kind: "refused";
  status: 400 | 409 | 422 | 503;
  body: ApiError;
};

/** What one generated action call came to. */
export type Dispatched = { kind: "done"; result: unknown } | Refused;

const refused = (
  status: Refused["status"],
  error: string,
  code: string,
  detail: string
): Refused => ({ kind: "refused", status, body: { error, detail, code } });

/** A stream the caller named that its state doesn't serve. */
export const invalid_stream = (detail: string) =>
  refused(422, "InvalidStream", "INVALID_STREAM", detail);
const MISSING_KEY = refused(
  400,
  "BadRequest",
  "BAD_REQUEST",
  "Idempotency-Key required"
);
const IN_FLIGHT = refused(
  503,
  "ServiceUnavailable",
  "IN_FLIGHT",
  "Idempotency-Key in flight; the original request has not finished, retry later"
);
const CONFLICT = refused(
  409,
  "Conflict",
  "CONFLICT",
  "Idempotency-Key already used; original result not cached"
);

/**
 * One generated action call: resolve the target from the validated input,
 * then run `app.do` on the raw payload (it parses again itself, and a second
 * parse of the parsed value would run every `.transform()` twice), under
 * `Idempotency-Key` dedup when a store is set. A duplicate of a key still
 * running is `in-flight`, since the original may yet fail and release it;
 * one already committed is `conflict`.
 */
export function make_dispatch<C>(
  app: ActSurface,
  resolvers: TargetResolvers<C>,
  store: IdempotencyStore | undefined
) {
  // Counts claims per key, to tell the two kinds of duplicate apart.
  const tracker = store && track_in_flight(store);
  return async (
    action_name: string,
    input: unknown,
    payload: unknown,
    ctx: C,
    actor: Actor,
    key: () => string | undefined,
    addressed?: {
      stream: unknown;
      matches: (stream: string) => boolean;
    }
  ): Promise<Dispatched> => {
    // A caller-addressed state takes the caller's stream, once it matches the
    // state's pattern; every other state resolves it. `stream_patterns`
    // refused a state with neither at generation.
    if (
      addressed &&
      (typeof addressed.stream !== "string" ||
        !addressed.matches(addressed.stream))
    )
      return invalid_stream(
        `"${String(addressed.stream)}" is not a stream of ${app.registry.actions[action_name]!.name}`
      );
    const stream = addressed
      ? (addressed.stream as string)
      : await resolvers.stream!(action_name, input, ctx);
    const expected = await resolvers.expectedVersion?.(action_name, input, ctx);
    const target =
      expected === undefined
        ? { stream, actor }
        : { stream, actor, expectedVersion: expected };
    const run = () => app.do(action_name, target, payload);
    if (!tracker) return { kind: "done", result: await run() };
    const k = key();
    if (!k) return MISSING_KEY;
    const outcome = await withIdempotency(tracker.store, k, run);
    if (!outcome.deduped) return { kind: "done", result: outcome.result };
    return tracker.in_flight(k) ? IN_FLIGHT : CONFLICT;
  };
}
