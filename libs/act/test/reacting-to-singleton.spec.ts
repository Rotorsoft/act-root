import { z } from "zod";
import { act, dispose, state, store } from "../src/index.js";

/**
 * #1541 on the singleton-port path.
 *
 * The sandbox-based cases in `reacting-to.spec.ts` build with
 * `ActOptions.scoped`, which installs the ports AsyncLocalStorage. The
 * reporting app runs the other configuration entirely: reactions declared
 * straight on `act()` (no `slice()`), ports injected through the singleton
 * `store(adapter)`, so `_scoped` is the identity wrapper and no ports ALS
 * exists at all. The ambient reaction context has to stand on its own
 * there, which is what this exercises.
 */

const Invoice = state({ Invoice: z.object({ paid: z.boolean() }) })
  .init(() => ({ paid: false }))
  .emits({ PaymentReceived: z.object({ amount: z.number() }) })
  .patch({ PaymentReceived: () => ({ paid: true }) })
  .on({ RecordPayment: z.object({ amount: z.number() }) })
  .emit("PaymentReceived")
  .build();

const Book = state({ Book: z.object({ gross: z.number() }) })
  .init(() => ({ gross: 0 }))
  .emits({ GrossIncomeUpdated: z.object({ amount: z.number() }) })
  .patch({
    GrossIncomeUpdated: ({ data }, s) => ({ gross: s.gross + data.amount }),
  })
  .on({ UpdateGrossIncome: z.object({ amount: z.number() }) })
  .emit("GrossIncomeUpdated")
  .build();

const reaction_actor = { id: "system", name: "reaction" };

// The reporting shape: `app` is a module-level export and the handler
// closes over it instead of taking the injected third argument.
const app = act()
  .withState(Invoice)
  .withState(Book)
  .on("PaymentReceived")
  .do(async function bookIncome(event) {
    await app.do(
      "UpdateGrossIncome",
      { stream: "book-2026", actor: reaction_actor },
      { amount: event.data.amount }
    );
  })
  .to({ target: "book-income" })
  .build();

describe("ambient reactingTo on the singleton-port path (#1541)", () => {
  beforeEach(async () => {
    await store().seed();
  });

  afterAll(async () => {
    await dispose()();
  });

  it("threads the chain through a captured app with no scoped ports", async () => {
    await app.do(
      "RecordPayment",
      { stream: "invoice-1", actor: { id: "owner", name: "Consultant" } },
      { amount: 21240 }
    );
    await app.correlate();
    await app.drain();

    const [payment] = await app.query_array({
      stream: "invoice-1",
      stream_exact: true,
    });
    const [booked] = await app.query_array({
      stream: "book-2026",
      stream_exact: true,
    });

    expect(booked).toBeDefined();
    expect(booked.name).toBe("GrossIncomeUpdated");
    expect(booked.meta.correlation).toBe(payment.meta.correlation);
    expect(booked.meta.causation.event).toEqual({
      id: payment.id,
      name: "PaymentReceived",
      stream: "invoice-1",
    });
  });
});
