/**
 * A count on one stream makes everyone who takes a slot a rival of everyone
 * else. Splitting it across several streams means buyers on different streams
 * never conflict. Each stream holds its own share, so the total stays exact, but
 * one can fill while others have room, so a buyer tries the next, and "sold out"
 * takes asking them all. Split only when contention is a measured problem.
 *
 * Run from the repo root:
 *   LOG_LEVEL=error npx tsx recipes/rules-across-streams/examples/split-hot-stream.ts
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  act,
  ConcurrencyError,
  dispose,
  PreconditionError,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import { z } from "zod";

const SYSTEM = { id: "sale", name: "sale" };
export const SHARDS = 4;

const shardStream = (sale: string, shard: number) => `slots-${sale}-${shard}`;

const Allot = z.object({ slots: z.number().int().min(0) });

export const Slots = state({
  Slots: z.object({ slots: z.number(), taken: z.number() }),
})
  .init(() => ({ slots: 0, taken: 0 }))
  .emits({ Allotted: Allot, SlotTaken: ZodEmpty })
  .patch({
    Allotted: ({ data }) => ({ slots: data.slots }),
    SlotTaken: (_, state) => ({ taken: state.taken + 1 }),
  })
  .on({ Allot })
  .emit("Allotted")
  .build();

const Claim = z.object({ sale: z.string(), shard: z.number() });

export const Order = state({ Order: Claim })
  .init(() => ({ sale: "", shard: 0 }))
  .emits({ Claimed: Claim })
  .on({ Claim })
  .loads(Slots, (data) => shardStream(data.sale, data.shard), ["SlotTaken"])
  .requires([
    {
      description: "a free slot",
      holds: (_, __, ___, { Slots }) => Slots.taken < Slots.slots,
    },
  ])
  .emit((data) => [
    ["Claimed", data],
    ["SlotTaken", {}],
  ])
  .build();

export const builder = act().withState(Slots).withState(Order);

type App = ReturnType<typeof builder.build>;

/** Shares a sale's slots across its streams. */
export async function open(app: App, sale: string, slots: number) {
  for (let shard = 0; shard < SHARDS; shard++) {
    const share = Math.floor(slots / SHARDS) + (shard < slots % SHARDS ? 1 : 0);
    await app.do(
      "Allot",
      { stream: shardStream(sale, shard), actor: SYSTEM },
      { slots: share }
    );
  }
}

// The same buyer always starts on the same stream, and buyers spread evenly.
const firstShard = (buyer: string) =>
  createHash("sha256").update(buyer).digest().readUInt32BE() % SHARDS;

/**
 * Takes a slot for a buyer, trying each stream in turn. A stream that lost a
 * race is tried again later; `false` means every stream said it was full.
 */
export async function claim(app: App, sale: string, buyer: string) {
  const start = firstShard(buyer);
  const open_shards = new Set(
    Array.from({ length: SHARDS }, (_, i) => (start + i) % SHARDS)
  );
  while (open_shards.size) {
    for (const shard of open_shards) {
      try {
        await app.do(
          "Claim",
          {
            stream: `order-${sale}-${buyer}`,
            actor: { id: buyer, name: buyer },
          },
          { sale, shard }
        );
        return true;
      } catch (error) {
        if (error instanceof PreconditionError) open_shards.delete(shard);
        else if (!(error instanceof ConcurrencyError)) throw error;
      }
    }
  }
  return false;
}

/** The sale's total comes from reading every stream. */
export async function taken(app: App, sale: string) {
  let total = 0;
  for (let shard = 0; shard < SHARDS; shard++)
    total += (await app.load(Slots, shardStream(sale, shard))).state.taken;
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = builder.build();
  await open(app, "launch", 10);
  const results = await Promise.all(
    Array.from({ length: 14 }, (_, i) => claim(app, "launch", `buyer-${i}`))
  );
  console.log("claimed", results.filter(Boolean).length, "of 14");
  console.log("slots taken", await taken(app, "launch"));
  await dispose()();
}
