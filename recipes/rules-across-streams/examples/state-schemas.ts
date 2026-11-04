/**
 * Another state's schema holds the rule: whichever action emits into it, the
 * fold is checked before the commit, so no path can break it.
 */
import { slice, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const SYSTEM = { id: "system", name: "rules" };

// ── Room booking: no two bookings overlap ───────────────────────────────

const Slot = z.object({ from: z.number(), to: z.number() });
const overlap = (a: z.infer<typeof Slot>, b: z.infer<typeof Slot>) =>
  a.from < b.to && b.from < a.to;

export const Room = state({
  Room: z
    .object({ slots: z.array(Slot) })
    .refine(
      ({ slots }) =>
        slots.every((a, i) => slots.slice(i + 1).every((b) => !overlap(a, b))),
      "the room is double-booked"
    ),
})
  .init(() => ({ slots: [] }))
  .emits({ RoomReserved: Slot })
  .patch({
    RoomReserved: ({ data }, state) => ({ slots: [...state.slots, data] }),
  })
  .build();

const Book = Slot.extend({ room: z.string() });

export const Booking = state({ Booking: Book })
  .init(() => ({ room: "", from: 0, to: 0 }))
  .emits({ Booked: Book })
  .on({ Book }, { maxRetries: 4 })
  .loads(Room, (data) => `room-${data.room}`, ["RoomReserved"])
  .emit((data) => [
    ["Booked", data],
    ["RoomReserved", { from: data.from, to: data.to }],
  ])
  .build();

// ── Invoice payments: never more than the invoice ───────────────────────

const Amount = z.object({ amount: z.number() });

export const Invoice = state({
  Invoice: z
    .object({ amount: z.number(), paid: z.number() })
    .refine((s) => s.paid <= s.amount, "overpaid"),
})
  .init(() => ({ amount: 0, paid: 0 }))
  .emits({ InvoiceIssued: Amount, PaymentApplied: Amount })
  .patch({
    InvoiceIssued: ({ data }) => ({ amount: data.amount }),
    PaymentApplied: ({ data }, state) => ({ paid: state.paid + data.amount }),
  })
  .on({ IssueInvoice: Amount })
  .emit("InvoiceIssued")
  .build();

const Pay = z.object({ invoice: z.string(), amount: z.number() });

export const Payment = state({ Payment: Pay })
  .init(() => ({ invoice: "", amount: 0 }))
  .emits({ Paid: Pay })
  .on({ Pay }, { maxRetries: 4 })
  .loads(Invoice, (data) => data.invoice, ["PaymentApplied"])
  .emit((data) => [
    ["Paid", data],
    ["PaymentApplied", { amount: data.amount }],
  ])
  .build();

// ── Inventory: stock never below zero, expired holds freed ──────────────

const Qty = z.object({ qty: z.number() });

export const Product = state({
  Product: z.object({ stock: z.number().min(0), price: z.number() }),
})
  .init(() => ({ stock: 0, price: 0 }))
  .emits({
    Restocked: Qty,
    PriceSet: z.object({ price: z.number() }),
    StockReserved: Qty,
    StockReleased: Qty,
  })
  .patch({
    Restocked: ({ data }, state) => ({ stock: state.stock + data.qty }),
    PriceSet: ({ data }) => ({ price: data.price }),
    StockReserved: ({ data }, state) => ({ stock: state.stock - data.qty }),
    StockReleased: ({ data }, state) => ({ stock: state.stock + data.qty }),
  })
  .on({ Restock: Qty })
  .emit("Restocked")
  .on({ SetPrice: z.object({ price: z.number() }) })
  .emit("PriceSet")
  .build();

const ReserveItem = Qty.extend({
  product: z.string(),
  expiresAt: z.number(),
});

export const Order = state({
  Order: z.object({
    product: z.string(),
    qty: z.number(),
    status: z.enum(["new", "held", "confirmed", "expired"]),
  }),
})
  .init(() => ({ product: "", qty: 0, status: "new" }))
  .emits({
    ItemReserved: ReserveItem,
    OrderConfirmed: ZodEmpty,
    HoldExpired: ZodEmpty,
  })
  .patch({
    ItemReserved: ({ data }) => ({
      product: data.product,
      qty: data.qty,
      status: "held",
    }),
    OrderConfirmed: () => ({ status: "confirmed" }),
    HoldExpired: () => ({ status: "expired" }),
  })
  .on({ ReserveItem }, { maxRetries: 4 })
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
  .on({ ConfirmOrder: ZodEmpty })
  .requires([
    {
      description: "the order is held",
      holds: (_, state) => state.status === "held",
    },
  ])
  .emit("OrderConfirmed")
  .on({ ExpireHold: ZodEmpty }, { maxRetries: 4 })
  .loads(Product, (_, state) => state.product, ["StockReleased"])
  .requires([
    {
      description: "the order is held",
      holds: (_, state) => state.status === "held",
    },
  ])
  .emit((_, { state }) => [
    ["HoldExpired", {}],
    ["StockReleased", { qty: state.qty }],
  ])
  .build();

/** A confirmed order keeps its stock when the timer comes due. */
export const HoldTimers = slice()
  .withState(Order)
  .withState(Product)
  .on("ItemReserved")
  .defer((event) => ({ at: new Date(event.data.expiresAt) }))
  .do(async function expireHold(event, _target, app) {
    const { state } = await app.load("Order", event.stream);
    if (state.status !== "held") return;
    await app.do("ExpireHold", { stream: event.stream, actor: SYSTEM }, {});
  })
  .to((event) => ({ target: `hold-${event.stream}`, source: event.stream }))
  .build();

// ── Bike rental: rented only when free ──────────────────────────────────

export const Bike = state({
  Bike: z.object({ status: z.enum(["free", "rented"]) }),
})
  .init(() => ({ status: "free" }))
  .emits({ BikeReserved: ZodEmpty })
  .patch({ BikeReserved: () => ({ status: "rented" }) })
  .build();

const ReserveBike = z.object({ bike: z.string() });

export const Rental = state({ Rental: ReserveBike })
  .init(() => ({ bike: "" }))
  .emits({ RentalOpened: ReserveBike })
  .on({ ReserveBike }, { maxRetries: 1 })
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
