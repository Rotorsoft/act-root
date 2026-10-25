import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  act,
  ConcurrencyError,
  type Invariant,
  InvariantError,
  type Precondition,
  state,
} from "../src/index.js";
import { sandbox } from "../src/test/index.js";

/**
 * Preconditions: named rules an action requires, declared with
 * `.requires([...])`, that read the payload as well as the state. They run
 * after the invariants in `.given([...])`, in declaration order, and the
 * first that doesn't hold refuses the action with an `InvariantError`.
 */
type Board = { owner: Record<string, string>; armies: Record<string, number> };
const Board = z.object({
  owner: z.record(z.string(), z.string()),
  armies: z.record(z.string(), z.number()),
});
const Move = z.object({ from: z.string(), to: z.string(), count: z.number() });
const Claim = z.object({ from: z.string() });

const open: Invariant<Board> = {
  description: "The board must be open",
  valid: (s) => Object.keys(s.owner).length > 0,
};
// Typed over the part of the payload it reads, so both actions can use it.
const ownsFrom: Precondition<Board, { from: string }> = {
  description: "You must own the source",
  holds: ({ from }, s, actor) => s.owner[from] === actor?.id,
};
const enoughArmies: Precondition<Board, { from: string; count: number }> = {
  description: "Leave at least one army behind",
  holds: ({ from, count }, s) => (s.armies[from] ?? 0) > count,
};

const seen: string[] = [];
const traced = <P>(rule: Precondition<Board, P>): Precondition<Board, P> => ({
  description: rule.description,
  holds: (p, s, a) => {
    seen.push(rule.description);
    return rule.holds(p, s, a);
  },
});

const game = state({ Board })
  .init(() => ({ owner: {}, armies: {} }))
  .emits({
    Seeded: z.object({ territory: z.string(), owner: z.string() }),
    Moved: Move,
    Claimed: Claim,
  })
  .patch({
    Seeded: ({ data }, s) => ({
      owner: { ...s.owner, [data.territory]: data.owner },
      armies: { ...s.armies, [data.territory]: 3 },
    }),
    Moved: ({ data }, s) => ({
      armies: {
        ...s.armies,
        [data.from]: (s.armies[data.from] ?? 0) - data.count,
        [data.to]: (s.armies[data.to] ?? 0) + data.count,
      },
    }),
    Claimed: () => ({}),
  })
  .on({ seed: z.object({ territory: z.string(), owner: z.string() }) })
  .emit("Seeded")
  .on({ move: Move })
  .given([open])
  .requires([traced(ownsFrom), traced(enoughArmies)])
  .emit("Moved")
  // `.requires` without `.given`, reusing the same precondition.
  .on({ claim: Claim })
  .requires([ownsFrom])
  .emit("Claimed")
  .build();

const ann = { id: "ann", name: "Ann" };
const bob = { id: "bob", name: "Bob" };

async function board() {
  const sb = await sandbox(act().withState(game));
  await sb.app.do(
    "seed",
    { stream: "b", actor: ann },
    { territory: "x", owner: "ann" }
  );
  seen.length = 0;
  return sb;
}

describe("preconditions", () => {
  it("runs the action when every precondition holds", async () => {
    const { app, dispose } = await board();
    try {
      const [snap] = await app.do(
        "move",
        { stream: "b", actor: ann },
        { from: "x", to: "y", count: 2 }
      );
      expect(snap.state.armies).toEqual({ x: 1, y: 2 });
      expect(seen).toEqual([
        "You must own the source",
        "Leave at least one army behind",
      ]);
    } finally {
      await dispose();
    }
  });

  it("refuses at the first precondition that doesn't hold, and commits nothing", async () => {
    const { app, dispose } = await board();
    try {
      const refused = app.do(
        "move",
        { stream: "b", actor: bob },
        { from: "x", to: "y", count: 1 }
      );
      await expect(refused).rejects.toBeInstanceOf(InvariantError);
      await expect(refused).rejects.toMatchObject({
        description: "You must own the source",
        message: "move failed precondition: You must own the source",
        payload: { from: "x", to: "y", count: 1 },
      });
      // The second precondition never ran.
      expect(seen).toEqual(["You must own the source"]);
      const after = await app.load(game, "b");
      expect(after.state.armies).toEqual({ x: 3 });
    } finally {
      await dispose();
    }
  });

  it("passes the validated payload, the state and the actor to holds", async () => {
    const calls: unknown[][] = [];
    const Pile = state({ Pile: z.object({ size: z.number() }) })
      .init(() => ({ size: 5 }))
      .emits({ Took: z.object({ count: z.number() }) })
      .on({ take: z.object({ count: z.number().default(1) }) })
      .requires([
        {
          description: "Enough left",
          holds: (payload, s, actor) => {
            calls.push([payload, s, actor]);
            return s.size >= payload.count;
          },
        },
      ])
      .emit("Took")
      .build();
    const { app, dispose } = await sandbox(act().withState(Pile));
    try {
      // The schema fills in `count`, so holds sees the parsed payload.
      await app.do("take", { stream: "p", actor: ann }, {} as never);
      expect(calls).toEqual([[{ count: 1 }, { size: 5 }, ann]]);
    } finally {
      await dispose();
    }
  });

  it("re-checks the preconditions against the reloaded state when a retry follows a conflict", async () => {
    let checks = 0;
    const Pot = state({ Pot: z.object({ left: z.number() }) })
      .init(() => ({ left: 3 }))
      .emits({ Took: z.object({ count: z.number() }) })
      .patch({ Took: ({ data }, s) => ({ left: s.left - data.count }) })
      .on({ take: z.object({ count: z.number() }) }, { maxRetries: 1 })
      .requires([
        {
          description: "Enough left",
          holds: ({ count }, s) => {
            checks++;
            return s.left >= count;
          },
        },
      ])
      .emit("Took")
      .build();
    const { app, store, dispose } = await sandbox(act().withState(Pot));
    try {
      // A rival takes two between this action's load and its commit.
      const commit = store.commit.bind(store);
      vi.spyOn(store, "commit").mockImplementationOnce(
        async (stream, msgs, meta) => {
          await commit(stream, [{ name: "Took", data: { count: 2 } }], meta);
          throw new ConcurrencyError(stream, 0, msgs, -1);
        }
      );
      await expect(
        app.do("take", { stream: "pot", actor: ann }, { count: 2 })
      ).rejects.toMatchObject({
        message: "take failed precondition: Enough left",
      });
      expect(checks).toBe(2);
      const after = await app.load(Pot, "pot");
      expect(after.state.left).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("checks the invariants first: a failing invariant runs no precondition", async () => {
    const { app, dispose } = await sandbox(act().withState(game));
    try {
      seen.length = 0;
      await expect(
        app.do(
          "move",
          { stream: "empty", actor: ann },
          { from: "x", to: "y", count: 1 }
        )
      ).rejects.toMatchObject({
        description: "The board must be open",
        message: "move failed invariant: The board must be open",
      });
      expect(seen).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("shares one precondition between actions, and works without .given", async () => {
    const { app, dispose } = await board();
    try {
      await expect(
        app.do("claim", { stream: "b", actor: bob }, { from: "x" })
      ).rejects.toMatchObject({
        message: "claim failed precondition: You must own the source",
      });
      const [snap] = await app.do(
        "claim",
        { stream: "b", actor: ann },
        { from: "x" }
      );
      expect(snap.event?.name).toBe("Claimed");
    } finally {
      await dispose();
    }
  });

  it("keeps each partial's preconditions when partial states merge", async () => {
    const extra = state({ Board })
      .init(() => ({ owner: {}, armies: {} }))
      .emits({ Fortified: Claim })
      .on({ fortify: Claim })
      .requires([ownsFrom])
      .emit("Fortified")
      .build();
    const { app, dispose } = await sandbox(
      act().withState(game).withState(extra)
    );
    try {
      await app.do(
        "seed",
        { stream: "m", actor: ann },
        { territory: "x", owner: "ann" }
      );
      await expect(
        app.do("fortify", { stream: "m", actor: bob }, { from: "x" })
      ).rejects.toMatchObject({
        message: "fortify failed precondition: You must own the source",
      });
      await expect(
        app.do("claim", { stream: "m", actor: bob }, { from: "x" })
      ).rejects.toMatchObject({
        message: "claim failed precondition: You must own the source",
      });
    } finally {
      await dispose();
    }
  });
});
