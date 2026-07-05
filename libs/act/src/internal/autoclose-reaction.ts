/**
 * @module autoclose-reaction
 * @category Internal
 *
 * Synthesis of the online close-the-books reaction. `.autocloses(policy)`
 * is not a sweep: it is a reaction on every event the declaring state owns
 * that evaluates the policy against the LIVE head (so a reopened stream
 * re-evaluates correctly), defers to the cooldown's earliest opening
 * (`head.created + the policy's min after`), and closes via `CloseSignal`
 * once the policy holds.
 *
 * Runs at build time — after the registry is fully merged and before the
 * orchestrator classifies it — so the synthesized dynamic resolver is
 * discovered by `classify_registry` and its target stream subscribed. The
 * registry is complete once the builder finishes; the orchestrator never
 * mutates it.
 *
 * @internal
 */

import { store, TOMBSTONE_EVENT } from "../ports.js";
import type {
  Reaction,
  Registry,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import {
  type AutocloseConfig,
  in_autoclose_window,
} from "./autoclose-config.js";
import { CloseSignal } from "./close-signal.js";
import { DeferSignal } from "./defer-signal.js";

/**
 * Prefix for the synthetic per-aggregate stream the autoclose reaction
 * runs on. `target = \`${AUTOCLOSE_TARGET_PREFIX}${aggregate}\``, `source =
 * aggregate` — a watermark distinct from the aggregate's own reactions, so
 * an autoclose defer never short-circuits them. Internal; not a public
 * surface.
 */
export const AUTOCLOSE_TARGET_PREFIX = "__autoclose__:";

/**
 * Inject one synthesized autoclose reaction per `.autocloses(...)` state
 * into the registry's event registers. The handler resolves ports at call
 * time (`store()`), so the reaction is orchestrator-agnostic; the resolved
 * window/cadence config is captured here, at build.
 *
 * @internal
 */
export function synthesize_autoclose_reactions<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
>(
  registry: Registry<TSchemaReg, TEvents, TActions>,
  states: ReadonlyMap<string, State<any, any, any>>,
  config: AutocloseConfig
): void {
  for (const st of states.values()) {
    const predicate = st.autoclose;
    if (!predicate) continue;
    const after_ms = st.autoclose_after_ms;
    const archiver = st.archive;
    const reaction: Reaction<TEvents> = {
      // Run on a SYNTHETIC stream — `source` is the aggregate, `target` is a
      // per-aggregate `__autoclose__` key — so the autoclose reaction never
      // shares a watermark with the aggregate's own reactions. A shared
      // watermark would let autoclose's defer short-circuit the aggregate's
      // other reactions (the "a defer affects all reactions on a stream"
      // hazard). The close still targets the aggregate (`source`).
      resolver: (e) => ({
        target: `${AUTOCLOSE_TARGET_PREFIX}${e.stream}`,
        source: e.stream,
      }),
      // Never block on autoclose: a transient query/store error should retry,
      // not quarantine the synthetic stream.
      options: { blockOnError: false, maxRetries: 3 },
      handler: async (event) => {
        const aggregate = event.stream;
        // Off-hours gating: outside the window, re-check next cycle
        // instead of closing.
        if (!in_autoclose_window(config.autocloseWindow, new Date()))
          throw new DeferSignal({
            at: new Date(Date.now() + config.autocloseCycleMinutes * 60_000),
          });
        const stats = await store().query_stats([aggregate], {
          count: true,
          exclude: [TOMBSTONE_EVENT],
        });
        const entry = stats.get(aggregate);
        // No live (non-tombstone) head → already closed, nothing to do.
        if (!entry) return;
        const head = entry.head;
        // `count` is always present — query_stats is called with
        // `count: true` above, so the option contract guarantees it.
        if (predicate(aggregate, head, entry.count!))
          throw new CloseSignal({
            stream: aggregate,
            archive: archiver ? () => archiver(aggregate, head) : undefined,
            // Ack this reaction's own watermark to the live head so the
            // close-cycle guard (which matches subscriptions by source =
            // aggregate) sees it caught up instead of blocking its own close.
            at: head.id,
          });
        // Not eligible yet: park on the cooldown's earliest opening when the
        // policy has a time gate; otherwise wait for the next event to
        // re-trigger (e.g. a `reaches` threshold).
        if (after_ms !== undefined)
          throw new DeferSignal({
            at: new Date(head.created.getTime() + after_ms),
          });
      },
    };
    const key = `__autoclose_${st.name}`;
    for (const event_name of Object.keys(st.events)) {
      registry.events[event_name as keyof TEvents]?.reactions.set(
        key,
        reaction as Reaction<TEvents, keyof TEvents>
      );
    }
  }
}
