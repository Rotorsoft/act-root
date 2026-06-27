/**
 * Cooldown-after-terminal close policy — the primary pattern.
 *
 * Tickets resolve, then sit in primary storage for a 90-day return /
 * dispute / customer-success window, then retire themselves on the
 * next autoclose cycle. The `.autocloses({...})` declarator does
 * the work; the rest of the file is a minimal harness so this can
 * be run end-to-end with `tsx` to confirm the API wiring.
 *
 * Run:  pnpm tsx recipes/scaling/close-the-books/examples/ticket-cooldown.ts
 */

import { act, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const Ticket = state({
  Ticket: z.object({ title: z.string(), open: z.boolean() }),
})
  .init(() => ({ title: "", open: false }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketResolved: ZodEmpty,
  })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, open: true }),
    TicketResolved: (_e, state) => ({ ...state, open: false }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
  .emit((a) => ["TicketOpened", { title: a.title }])
  .on({ ResolveTicket: ZodEmpty })
  .emit(() => ["TicketResolved", {}])
  // The recipe — declarative form, top-level AND.
  // "autocloses is Resolved after 90 days."
  .autocloses({
    is: "TicketResolved",
    after: { days: 90 },
  })
  .build();

async function main() {
  const app = act().withState(Ticket).build({
    // 12 h is the default sweep cadence; spelled out here so the
    // example doubles as a knobs reference.
    autocloseCycleMinutes: 720,
    closeBatchSize: 64,
  });

  // The registry exposes the compiled predicate. Useful in tests
  // to assert the policy survived `act().build()` validation.
  const predicate = app.registry.autoclose_policy("Ticket");
  console.log("Ticket.autoclose registered:", typeof predicate === "function");

  // Commit a ticket so the cycle has something to look at the first
  // time it ticks. Default storage is in-memory, so no DB connection
  // is needed to verify the wiring.
  const actor = { id: "demo", name: "demo" };
  await app.do("OpenTicket", { stream: "ticket-1", actor }, { title: "demo" });
  await app.do("ResolveTicket", { stream: "ticket-1", actor }, {});

  // `start_correlations()` also starts the autoclose ticker.
  // A predicate keyed on `after: { days: 90 }` will not fire on a
  // ticket that resolved seconds ago — the example proves the wiring
  // up, not the eviction.
  app.start_correlations();

  // Tear down cleanly so the script exits.
  await app.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
