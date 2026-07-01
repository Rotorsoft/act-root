import { randomUUID } from "node:crypto";
import { DeferSignal, type IAct, slice } from "@rotorsoft/act";
import { reassignAgent } from "./services/agent.js";
import { TicketCreation } from "./ticket-creation.js";
import { TicketOperations } from "./ticket-operations.js";

/**
 * Timing automations, expressed as deferred reactions instead of the old
 * `setInterval` polling jobs (#1091). Each ticket's deadlines already ride on
 * its events (`escalateAfter`/`reassignAfter` on `TicketAssigned`, `closeAfter`
 * on `TicketOpened`), so the reaction just `.defer`s to that instant and acts
 * when it wakes, re-checking live state the way the jobs re-queried the
 * projection.
 *
 * Each automation runs on its own per-ticket target (`escalate:<id>` etc.) so a
 * pending timer never holds the ticket's hot-path reactions (assignment,
 * messaging, webhooks). Handlers read the *source* ticket from `event.stream`,
 * not the synthetic target they lease.
 */

const SYS = { id: randomUUID(), name: "ticket-timers" };

/**
 * Reassign the ticket if it's still open, escalated, past its reassign
 * deadline, and the user hasn't been answered. The escalation event carries no
 * deadline, so `reassignAfter` is read from live state; each `ReassignTicket`
 * pushes it forward, so the follow-on `TicketReassigned` re-arms the chain.
 * Mirrors the guard conditions so the action never throws.
 */
async function reassign_if_due(stream: string, app: IAct) {
  const { state } = await app.load("Ticket", stream);
  if (state.closedById || !state.escalationId || !state.reassignAfter) return;
  const acked = Object.values(
    state.messages as Record<string, { wasRead?: boolean; from: string }>
  ).some((m) => m.wasRead && m.from === state.userId);
  if (acked) return;
  if (Date.now() < state.reassignAfter.getTime())
    throw new DeferSignal({ at: state.reassignAfter });
  await app.do("ReassignTicket", { stream, actor: SYS }, reassignAgent(stream));
}

// --- Slice -------------------------------------------------------------------
// prettier-ignore
export const TicketTimersSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)

  // Escalate: one-shot, fires at the assignment's escalateAfter.
  .on("TicketAssigned")
  .defer((event) => ({ at: event.data.escalateAfter }))
  .do(async function autoEscalate(event, _target, app) {
    const { state } = await app.load("Ticket", event.stream);
    if (state.closedById || state.escalationId) return;
    await app.do(
      "EscalateTicket",
      { stream: event.stream, actor: SYS },
      { requestId: randomUUID(), requestedById: SYS.id }
    );
  })
  .to((event) => ({ target: `escalate:${event.stream}`, source: event.stream }))

  // Reassign: recurring chain, re-armed by each TicketReassigned.
  .on("TicketEscalated")
  .do(async function autoReassign(event, _target, app) {
    await reassign_if_due(event.stream, app);
  })
  .to((event) => ({ target: `reassign:${event.stream}`, source: event.stream }))

  .on("TicketReassigned")
  .do(async function autoReassignAgain(event, _target, app) {
    await reassign_if_due(event.stream, app);
  })
  .to((event) => ({ target: `reassign:${event.stream}`, source: event.stream }))

  // Close on inactivity: fires at the open event's closeAfter (optional).
  .on("TicketOpened")
  .do(async function autoClose(event, _target, app) {
    const closeAfter = event.data.closeAfter;
    if (!closeAfter) return;
    if (Date.now() < closeAfter.getTime())
      throw new DeferSignal({ at: closeAfter });
    const { state } = await app.load("Ticket", event.stream);
    if (state.closedById) return;
    await app.do("CloseTicket", { stream: event.stream, actor: SYS }, {});
  })
  .to((event) => ({ target: `close:${event.stream}`, source: event.stream }))

  .build();
