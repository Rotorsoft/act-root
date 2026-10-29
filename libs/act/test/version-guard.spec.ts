import { z } from "zod";
import {
  act,
  ConcurrencyError,
  InMemoryStore,
  PreconditionError,
  state,
  ValidationError,
} from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type {
  Committed,
  EventMeta,
  Message,
  Schemas,
} from "../src/types/index.js";

/** Holds the next commit until released, so a second writer lands first. */
class GatedStore extends InMemoryStore {
  gate?: Promise<void>;
  override async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ): Promise<Committed<E, keyof E>[]> {
    if (this.gate) {
      const g = this.gate;
      this.gate = undefined;
      await g;
    }
    return super.commit(stream, msgs, meta, expectedVersion);
  }
}

const reacting_to = {
  id: 0,
  name: "Triggered",
  stream: "elsewhere",
  version: 0,
  created: new Date(),
  data: {},
  meta: { correlation: "c", causation: {} },
} as unknown as Committed<Schemas, string>;

const actor = { id: "a", name: "a" };

/**
 * Every action commits with the version it loaded, a new stream's -1 and a
 * reaction's dispatch included, so a writer whose load went stale is refused
 * and its preconditions and state check never pass on old state.
 */
describe("version guard", () => {
  // At most two tickets, opened once, and only an open ticket escalates.
  const Ticket = (maxRetries = 0) =>
    state({
      Ticket: z.object({
        opened: z.boolean(),
        closed: z.boolean(),
        escalations: z.number().max(2),
      }),
    })
      .init(() => ({ opened: false, closed: false, escalations: 0 }))
      .emits({
        opened: z.object({}),
        closed: z.object({}),
        escalated: z.object({}),
      })
      .patch({
        opened: () => ({ opened: true }),
        closed: () => ({ closed: true }),
        escalated: (_, s) => ({ escalations: s.escalations + 1 }),
      })
      .on({ open: z.object({}) }, { maxRetries })
      .requires([
        { description: "cannot open twice", holds: (_, s) => !s.opened },
      ])
      .emit(() => ["opened", {}])
      .on({ close: z.object({}) })
      .emit(() => ["closed", {}])
      .on({ escalate: z.object({}) }, { maxRetries })
      .requires([{ description: "must be open", holds: (_, s) => !s.closed }])
      .emit(() => ["escalated", {}])
      .build();

  // Starts `first`, lets `second` commit inside its load-to-commit window,
  // then releases `first`.
  const race = async (
    gated: GatedStore,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>
  ) => {
    let release!: () => void;
    gated.gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = first().then(
      () => "ok",
      (error: unknown) => error
    );
    await new Promise((r) => setTimeout(r, 5));
    await second();
    release();
    return slow;
  };

  it("lets only one of two callers create a new stream", async () => {
    const { app, dispose } = await sandbox(act().withState(Ticket()));
    const t = { stream: "t1", actor };
    const results = await Promise.allSettled([
      app.do("open", t, {}),
      app.do("open", t, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const lost = results.find((r) => r.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
      ConcurrencyError
    );
    expect(await app.query_array({ stream: "t1" })).toHaveLength(1);
    await dispose();
  });

  it("re-checks the precondition when the creator that lost retries", async () => {
    const { app, dispose } = await sandbox(act().withState(Ticket(1)));
    const t = { stream: "t2", actor };
    const results = await Promise.allSettled([
      app.do("open", t, {}),
      app.do("open", t, {}),
    ]);
    const lost = results.find((r) => r.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
      PreconditionError
    );
    expect(await app.query_array({ stream: "t2" })).toHaveLength(1);
    await dispose();
  });

  it("refuses a reaction whose load went stale", async () => {
    const gated = new GatedStore();
    const { app, dispose } = await sandbox(act().withState(Ticket()), {
      store: () => gated,
    });
    const t = { stream: "t3", actor };
    await app.do("open", t, {});
    const outcome = await race(
      gated,
      () => app.do("escalate", t, {}, { reactingTo: reacting_to }),
      () => app.do("close", t, {})
    );
    expect(outcome).toBeInstanceOf(ConcurrencyError);
    const names = (await app.query_array({ stream: "t3" })).map((e) => e.name);
    expect(names).toEqual(["opened", "closed"]);
    await dispose();
  });

  it("re-checks a reaction's precondition on the state it retries with", async () => {
    const gated = new GatedStore();
    const { app, dispose } = await sandbox(act().withState(Ticket(1)), {
      store: () => gated,
    });
    const t = { stream: "t4", actor };
    await app.do("open", t, {});
    const outcome = await race(
      gated,
      () => app.do("escalate", t, {}, { reactingTo: reacting_to }),
      () => app.do("close", t, {})
    );
    expect(outcome).toBeInstanceOf(PreconditionError);
    await dispose();
  });

  it("never lets a reaction store a state the schema rejects", async () => {
    const gated = new GatedStore();
    const { app, dispose } = await sandbox(act().withState(Ticket(1)), {
      store: () => gated,
    });
    const t = { stream: "t5", actor };
    await app.do("open", t, {});
    await app.do("escalate", t, {});
    // Both writers load one escalation; the second makes two, the cap.
    const outcome = await race(
      gated,
      () => app.do("escalate", t, {}, { reactingTo: reacting_to }),
      () => app.do("escalate", t, {}, { reactingTo: reacting_to })
    );
    expect(outcome).toBeInstanceOf(ValidationError);
    const snap = await app.load("Ticket", "t5");
    expect(snap.state.escalations).toBe(2);
    await app.do("close", t, {});
    await dispose();
  });
});
