/**
 * Terminal-with-retention-floor close policy — the OR-backstop pattern.
 *
 * Sessions usually close on `SessionEnded`. Some don't (the user closed
 * the tab, the device dropped off the network, the worker that would
 * have emitted the terminal event crashed). The retention floor — 365
 * days since the head event — catches the long tail so abandoned
 * streams don't accumulate forever.
 *
 * Run:  pnpm tsx recipes/scaling/close-the-books/examples/retention-floor.ts
 */

import { act, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const Session = state({
  Session: z.object({ user: z.string(), active: z.boolean() }),
})
  .init(() => ({ user: "", active: false }))
  .emits({
    SessionStarted: z.object({ user: z.string() }),
    SessionEnded: ZodEmpty,
  })
  .patch({
    SessionStarted: ({ data }) => ({ user: data.user, active: true }),
    SessionEnded: (_e, state) => ({ ...state, active: false }),
  })
  .on({ StartSession: z.object({ user: z.string() }) })
  .emit((a) => ["SessionStarted", { user: a.user }])
  .on({ EndSession: ZodEmpty })
  .emit(() => ["SessionEnded", {}])
  // The recipe — terminal event with a retention-floor backstop.
  // "autocloses is Ended, or after 365 days."
  // The two paths fire independently: a session that ends closes
  // promptly; a session that never ends closes a year later.
  .autocloses({
    is: "SessionEnded",
    or: { after: { days: 365 } },
  })
  .build();

async function main() {
  const app = act().withState(Session).build({
    autocloseCycleMs: 60_000,
    closeBatchSize: 64,
  });

  const predicate = app.registry.autoclose_policy("Session");
  console.log("Session.autoclose registered:", typeof predicate === "function");

  const actor = { id: "demo", name: "demo" };
  await app.do(
    "StartSession",
    { stream: "session-1", actor },
    { user: "alice" }
  );
  await app.do("EndSession", { stream: "session-1", actor }, {});

  // Second session, deliberately left unterminated. The retention
  // floor would catch it 365 days from now in a long-running process.
  await app.do(
    "StartSession",
    { stream: "session-orphan", actor },
    { user: "bob" }
  );

  app.start_correlations();
  await app.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
