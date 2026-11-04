import { PreconditionError, ValidationError } from "@rotorsoft/act";
import { describe, expect, vi } from "vitest";
import { Bike, Invoice, Order, Product, Room } from "./index.js";
import { at, events, test } from "./setup.js";

describe("room booking", () => {
  const book = (from: number, to: number) => ({ room: "r1", from, to });

  test("books free slots, and the room's schema refuses an overlap", async ({
    app,
  }) => {
    await app.do("Book", at("b-1"), book(9, 11));
    await app.do("Book", at("b-2"), book(11, 12));
    await expect(
      app.do("Book", at("b-3"), book(10, 12))
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await app.load(Room, "room-r1")).state.slots).toHaveLength(2);
    expect(await events("b-3")).toEqual([]);
  });
});

describe("invoice payments", () => {
  test("apply up to the amount, and the invoice's schema refuses more", async ({
    app,
  }) => {
    await app.do("IssueInvoice", at("inv-1"), { amount: 100 });
    await app.do("Pay", at("pay-1"), { invoice: "inv-1", amount: 60 });
    await expect(
      app.do("Pay", at("pay-2"), { invoice: "inv-1", amount: 50 })
    ).rejects.toBeInstanceOf(ValidationError);
    await app.do("Pay", at("pay-3"), { invoice: "inv-1", amount: 40 });
    expect((await app.load(Invoice, "inv-1")).state.paid).toBe(100);
  });
});

describe("inventory", () => {
  const hour = () => Date.now() + 3_600_000;
  const reserve = (qty: number, expiresAt = hour()) => ({
    product: "p-7",
    qty,
    expiresAt,
  });

  test("reserves what's in stock and refuses the rest", async ({ app }) => {
    await app.do("Restock", at("p-7"), { qty: 3 });
    await app.do("ReserveItem", at("o-1"), reserve(2));
    await expect(
      app.do("ReserveItem", at("o-2"), reserve(2))
    ).rejects.toBeInstanceOf(PreconditionError);
    expect((await app.load(Product, "p-7")).state.stock).toBe(1);
  });

  test("an expired hold gives its stock back", async ({ app }) => {
    await app.do("Restock", at("p-7"), { qty: 3 });
    await app.do("ReserveItem", at("o-1"), reserve(2, Date.now() + 40));
    await vi.waitFor(
      async () =>
        expect((await app.load(Order, "o-1")).state.status).toBe("expired"),
      { timeout: 4_000, interval: 25 }
    );
    expect((await app.load(Product, "p-7")).state.stock).toBe(3);
  });

  test("a confirmed order keeps its stock when the timer comes due", async ({
    app,
  }) => {
    await app.do("Restock", at("p-7"), { qty: 3 });
    await app.do("ReserveItem", at("o-1"), reserve(2, Date.now() + 40));
    await app.do("ConfirmOrder", at("o-1"), {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app.settle();
    expect((await app.load(Order, "o-1")).state.status).toBe("confirmed");
    expect((await app.load(Product, "p-7")).state.stock).toBe(1);
  });
});

describe("bike rental", () => {
  test("two riders racing for one bike: one rents it, the other is refused", async ({
    app,
  }) => {
    const results = await Promise.allSettled([
      app.do("ReserveBike", at("rent-1"), { bike: "bike-9" }),
      app.do("ReserveBike", at("rent-2"), { bike: "bike-9" }),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(PreconditionError);
    expect((await app.load(Bike, "bike-9")).state.status).toBe("rented");
  });
});
