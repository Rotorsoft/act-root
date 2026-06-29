/**
 * Cooldown-after-terminal close policy — the primary close-the-books
 * pattern, demonstrated on the canonical wolfdesk model rather than a
 * throwaway ticket.
 *
 * `@act/wolfdesk`'s `TicketCreation` state declares the policy directly
 * (see `packages/wolfdesk/src/ticket-creation.ts`):
 *
 *   .autocloses({
 *     is: ["TicketClosed", "TicketResolved"],   // terminal events
 *     after: { days: 90 },                       // 90-day cooldown
 *     or: { after: { days: 365 } },              // retention-floor backstop
 *   })
 *
 * A resolved/closed ticket sits in primary storage for the 90-day
 * return / dispute / customer-success window, then retires itself when
 * the autoclose reaction's cooldown elapses. The `or` backstop catches tickets that
 * never reach a terminal event so abandoned streams can't linger past
 * a year. This file is a minimal harness that confirms the policy is
 * wired on the real model.
 *
 * Run:  pnpm tsx recipes/scaling/close-the-books/examples/ticket-cooldown.ts
 */

import { app } from "@act/wolfdesk";

async function main() {
  // The registry exposes the compiled predicate that wolfdesk declared.
  // Its presence proves the policy survived `act().build()` validation.
  const predicate = app.registry.autoclose_policy("Ticket");
  console.log("Ticket.autoclose registered:", typeof predicate === "function");

  // `start_correlations()` also starts the autoclose ticker. A policy
  // keyed on `after: { days: 90 }` won't fire on a ticket that resolved
  // seconds ago — this proves the wiring, not the eviction.
  app.start_correlations();
  await app.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
