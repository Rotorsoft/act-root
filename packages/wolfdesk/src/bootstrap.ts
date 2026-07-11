import { act, type Correlator } from "@rotorsoft/act";
import {
  TicketCreationSlice,
  TicketMessagingSlice,
  TicketOpsSlice,
  TicketTimersSlice,
  TicketWebhooksSlice,
} from "./ticket.js";
import { TicketProjection } from "./ticket-projections.js";

export * from "./errors.js";
export * from "./ticket.js";

/**
 * Wolfdesk demonstrates a custom {@link Correlator} that embeds a short
 * tenant slug at the front of every correlation id. In a multi-tenant
 * SaaS this lets operators grep `tenantA-tick-...` to isolate a single
 * tenant's workflows in logs without joining back to actor metadata.
 *
 * Falls back to the default 4+4+8 shape when actor.id can't be parsed
 * as a tenant-qualified id (e.g., bootstrap actors during job runs).
 */
const tenantCorrelator: Correlator = ({ state, action, actor }) => {
  // Convention here: an actor id formatted as `<tenant>:<userId>`. Real
  // apps would read from a typed actor field.
  const tenant = (actor.id.split(":")[0] || "all").slice(0, 6).toLowerCase();
  const s = state.slice(0, 4).toLowerCase();
  const a = action.slice(0, 4).toLowerCase();
  const ts = (Date.now() % 36 ** 4).toString(36).padStart(4, "0");
  const rnd = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${tenant}-${s}-${a}-${ts}${rnd}`;
};

/**
 * The wired builder. Exported so tests can spin up an isolated, scoped Act
 * per suite via `sandbox(builder, { actOptions: { correlator } })` instead
 * of sharing the production singleton on the default port.
 */
// prettier-ignore
export const builder = act()
  .withSlice(TicketCreationSlice)
  .withSlice(TicketMessagingSlice)
  .withSlice(TicketOpsSlice)
  .withSlice(TicketTimersSlice)
  .withSlice(TicketWebhooksSlice)
  .withProjection(TicketProjection);

/** Production singleton (used by `main.ts`). */
export const app = builder.build({ correlator: tenantCorrelator });

export { tenantCorrelator };
