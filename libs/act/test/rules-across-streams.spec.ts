import { describe, expect } from "vitest";
import { z } from "zod";
import {
  act,
  PreconditionError,
  state,
  ValidationError,
} from "../src/index.js";
import { fixture } from "../src/test/index.js";

/**
 * The scenarios of RFC 2251 (rules that span streams), each as an app: the
 * rule is a precondition over a loaded state, or the loaded state's own
 * schema, and the events land in every stream in one commit.
 */

const actor = { id: "a", name: "a" };
const at = (stream: string) => ({ stream, actor });

describe("room booking: no two bookings of a room overlap", () => {
  const Slot = z.object({ from: z.number(), to: z.number() });
  const overlap = (a: z.infer<typeof Slot>, b: z.infer<typeof Slot>) =>
    a.from < b.to && b.from < a.to;
  // The room's schema forbids overlapping intervals, whoever emits.
  const Room = state({
    Room: z
      .object({ slots: z.array(Slot) })
      .refine(
        ({ slots }) =>
          slots.every((a, i) =>
            slots.slice(i + 1).every((b) => !overlap(a, b))
          ),
        "the room is double-booked"
      ),
  })
    .init(() => ({ slots: [] }))
    .emits({ RoomReserved: Slot })
    .patch({ RoomReserved: ({ data }, s) => ({ slots: [...s.slots, data] }) })
    .build();
  const Book = Slot.extend({ room: z.string() });
  const Booking = state({ Booking: Book })
    .init(() => ({ room: "", from: 0, to: 0 }))
    .emits({ Booked: Book })
    .on({ Book })
    .loads(Room, (data) => `room-${data.room}`, ["RoomReserved"])
    .emit((data) => [
      ["Booked", data],
      ["RoomReserved", { from: data.from, to: data.to }],
    ])
    .build();
  const test = fixture(act().withState(Room).withState(Booking));

  test("books a free slot and refuses an overlapping one", async ({ app }) => {
    await app.do("Book", at("b-1"), { room: "r1", from: 9, to: 11 });
    await app.do("Book", at("b-2"), { room: "r1", from: 11, to: 12 });
    await expect(
      app.do("Book", at("b-3"), { room: "r1", from: 10, to: 12 })
    ).rejects.toThrow(ValidationError);
    expect((await app.load(Room, "room-r1")).state.slots).toHaveLength(2);
  });
});

describe("invoice payments never exceed the invoice", () => {
  const Invoice = state({
    Invoice: z
      .object({ amount: z.number(), paid: z.number() })
      .refine((s) => s.paid <= s.amount, "overpaid"),
  })
    .init(() => ({ amount: 0, paid: 0 }))
    .emits({
      Issued: z.object({ amount: z.number() }),
      PaymentApplied: z.object({ amount: z.number() }),
    })
    .patch({
      Issued: ({ data }) => ({ amount: data.amount }),
      PaymentApplied: ({ data }, s) => ({ paid: s.paid + data.amount }),
    })
    .on({ Issue: z.object({ amount: z.number() }) })
    .emit("Issued")
    .build();
  const Pay = z.object({ invoice: z.string(), amount: z.number() });
  const Payment = state({ Payment: Pay })
    .init(() => ({ invoice: "", amount: 0 }))
    .emits({ Paid: Pay })
    .on({ Pay })
    .loads(Invoice, (data) => data.invoice, ["PaymentApplied"])
    .emit((data) => [
      ["Paid", data],
      ["PaymentApplied", { amount: data.amount }],
    ])
    .build();
  const test = fixture(act().withState(Invoice).withState(Payment));

  test("applies payments up to the amount, and refuses the overpayment", async ({
    app,
  }) => {
    await app.do("Issue", at("inv-1"), { amount: 100 });
    await app.do("Pay", at("pay-1"), { invoice: "inv-1", amount: 60 });
    await expect(
      app.do("Pay", at("pay-2"), { invoice: "inv-1", amount: 50 })
    ).rejects.toThrow(ValidationError);
    await app.do("Pay", at("pay-3"), { invoice: "inv-1", amount: 40 });
    expect((await app.load(Invoice, "inv-1")).state.paid).toBe(100);
  });
});

describe("inventory: stock never goes below zero", () => {
  const Qty = z.object({ qty: z.number() });
  const Product = state({ Product: z.object({ stock: z.number().min(0) }) })
    .init(() => ({ stock: 0 }))
    .emits({ Restocked: Qty, StockReserved: Qty })
    .patch({
      Restocked: ({ data }, s) => ({ stock: s.stock + data.qty }),
      StockReserved: ({ data }, s) => ({ stock: s.stock - data.qty }),
    })
    .on({ Restock: Qty })
    .emit("Restocked")
    .build();
  const Reserve = z.object({ product: z.string(), qty: z.number() });
  const Order = state({ Order: Reserve })
    .init(() => ({ product: "", qty: 0 }))
    .emits({ ItemReserved: Reserve })
    .on({ Reserve })
    .loads(Product, (data) => data.product, ["StockReserved"])
    .requires([
      {
        description: "enough stock",
        holds: (data, _, __, { Product }) => Product.stock >= data.qty,
      },
    ])
    .emit((data) => [
      ["ItemReserved", data],
      ["StockReserved", { qty: data.qty }],
    ])
    .build();
  const test = fixture(act().withState(Product).withState(Order));

  test("reserves what's in stock and refuses the rest", async ({ app }) => {
    await app.do("Restock", at("p-7"), { qty: 3 });
    await app.do("Reserve", at("o-1"), { product: "p-7", qty: 2 });
    await expect(
      app.do("Reserve", at("o-2"), { product: "p-7", qty: 2 })
    ).rejects.toThrow(PreconditionError);
    expect((await app.load(Product, "p-7")).state.stock).toBe(1);
  });
});

describe("gapless invoice numbers", () => {
  const Counter = state({ InvoiceCounter: z.object({ last: z.number() }) })
    .init(() => ({ last: 0 }))
    .emits({ NumberIssued: z.object({ number: z.number() }) })
    .patch({ NumberIssued: ({ data }) => ({ last: data.number }) })
    .build();
  const Bill = state({ Bill: z.object({ number: z.number() }) })
    .init(() => ({ number: 0 }))
    .emits({ Billed: z.object({ number: z.number() }) })
    .on({ Bill: z.object({}) }, { maxRetries: 5 })
    .loads(Counter, () => "invoices", ["NumberIssued"])
    .emit((_, __, ___, { InvoiceCounter }) => {
      const number = InvoiceCounter.last + 1;
      return [
        ["Billed", { number }],
        ["NumberIssued", { number }],
      ];
    })
    .build();
  const test = fixture(act().withState(Counter).withState(Bill));

  test("numbers concurrent bills 1..n with no gaps or repeats", async ({
    app,
  }) => {
    const bills = await Promise.all(
      [1, 2, 3, 4].map((i) => app.do("Bill", at(`bill-${i}`), {}))
    );
    expect(bills.map(([b]) => b.state.number).sort()).toEqual([1, 2, 3, 4]);
    expect((await app.load(Counter, "invoices")).state.last).toBe(4);
  });
});

describe("library loans: only the borrower returns a copy", () => {
  const Copy = state({ Copy: z.object({ borrower: z.string().optional() }) })
    .init(() => ({}))
    .emits({
      Lent: z.object({ member: z.string() }),
      CopyReturned: z.object({}),
    })
    .patch({
      Lent: ({ data }) => ({ borrower: data.member }),
      CopyReturned: () => ({ borrower: undefined }),
    })
    .on({ Lend: z.object({ member: z.string() }) })
    .emit("Lent")
    .build();
  const Member = state({ Member: z.object({ loans: z.number() }) })
    .init(() => ({ loans: 1 }))
    .emits({ LoanClosed: z.object({ copy: z.string() }) })
    .patch({ LoanClosed: (_, s) => ({ loans: s.loans - 1 }) })
    .build();
  const ReturnCopy = z.object({ copy: z.string(), member: z.string() });
  const Return = state({ Return: ReturnCopy })
    .init(() => ({ copy: "", member: "" }))
    .emits({ Returned: ReturnCopy })
    .on({ ReturnCopy })
    .loads(Copy, (data) => data.copy, ["CopyReturned"])
    .loads(Member, (data) => data.member, ["LoanClosed"])
    .requires([
      {
        description: "the copy is lent to this member",
        holds: (data, _, __, { Copy }) => Copy.borrower === data.member,
      },
    ])
    .emit((data) => [
      ["Returned", data],
      ["CopyReturned", {}],
      ["LoanClosed", { copy: data.copy }],
    ])
    .build();
  const test = fixture(
    act().withState(Copy).withState(Member).withState(Return)
  );

  test("closes the loan on both streams, and refuses another member", async ({
    app,
  }) => {
    await app.do("Lend", at("copy-1"), { member: "m-1" });
    await expect(
      app.do("ReturnCopy", at("ret-1"), { copy: "copy-1", member: "m-2" })
    ).rejects.toThrow("the copy is lent to this member");
    await app.do("ReturnCopy", at("ret-2"), { copy: "copy-1", member: "m-1" });
    expect((await app.load(Copy, "copy-1")).state.borrower).toBeUndefined();
    expect((await app.load(Member, "m-1")).state.loans).toBe(0);
  });
});

describe("bike rental: a bike is rented only when it's free", () => {
  const Bike = state({ Bike: z.object({ status: z.enum(["free", "rented"]) }) })
    .init(() => ({ status: "free" }))
    .emits({ BikeReserved: z.object({}) })
    .patch({ BikeReserved: () => ({ status: "rented" }) })
    .build();
  const Reserve = z.object({ bike: z.string() });
  const Rental = state({ Rental: Reserve })
    .init(() => ({ bike: "" }))
    .emits({ RentalOpened: Reserve })
    .on({ ReserveBike: Reserve }, { maxRetries: 1 })
    .loads(Bike, (data) => data.bike, ["BikeReserved"])
    .requires([
      {
        description: "the bike is available",
        holds: (_, __, ___, { Bike }) => Bike.status === "free",
      },
    ])
    .emit((data) => [
      ["RentalOpened", data],
      ["BikeReserved", {}],
    ])
    .build();
  const test = fixture(act().withState(Bike).withState(Rental));

  test("two riders racing for one bike: one rents it, the other is refused", async ({
    app,
  }) => {
    const results = await Promise.allSettled([
      app.do("ReserveBike", at("rent-1"), { bike: "bike-9" }),
      app.do("ReserveBike", at("rent-2"), { bike: "bike-9" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [refused] = results.filter((r) => r.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      PreconditionError
    );
  });
});
