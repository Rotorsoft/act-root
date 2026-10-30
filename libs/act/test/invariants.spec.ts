import { z } from "zod";
import {
  act,
  dispose,
  REDACTED,
  SHREDDED,
  sensitive,
  state,
  store,
  ValidationError,
} from "../src/index.js";

/**
 * Invariants are the state's schema. Every action checks the state it
 * leaves against that schema once, before the commit, so a broken
 * invariant refuses the action and nothing is stored. Loads and replays
 * don't check.
 */
describe("invariants", () => {
  // `z.number()` rejects NaN, so dividing by zero breaks the schema.
  const calc = () =>
    state({ Calc: z.object({ result: z.number() }) })
      .init(() => ({ result: 0 }))
      .emits({
        added: z.object({ by: z.number() }),
        dividedByZero: z.object({}),
      })
      .patch({
        added: (e, s) => ({ result: s.result + e.data.by }),
        dividedByZero: () => ({ result: 0 / 0 }),
      })
      .on({ add: z.object({ by: z.number() }) })
      .emit((a) => ["added", { by: a.by }])
      .on({ divide: z.object({}) })
      .emit(() => ["dividedByZero", {}])
      .build();

  const actor = { id: "u1", name: "Alice" };

  afterEach(async () => {
    await dispose()();
  });

  it("refuses before the commit: nothing is stored, no reaction runs, the stream keeps working", async () => {
    const reacted: string[] = [];
    const app = act()
      .withState(calc())
      .on("dividedByZero")
      .do(async function onDivided(e) {
        reacted.push(e.stream);
      })
      .to("divided")
      .build({ autoSettle: false });
    await app.do("add", { stream: "c0", actor }, { by: 1 });
    await expect(
      app.do("divide", { stream: "c0", actor }, {})
    ).rejects.toBeInstanceOf(ValidationError);
    const stored = await app.query_array({ stream: "c0" });
    expect(stored.map((e) => e.name)).toEqual(["added"]);
    const [snap] = await app.do("add", { stream: "c0", actor }, { by: 2 });
    expect(snap.state.result).toBe(3);
    await app.correlate();
    await app.drain();
    expect(reacted).toEqual([]);
  });

  it("names the state and the action in the error", async () => {
    const app = act().withState(calc()).build();
    const caught = await app
      .do("divide", { stream: "c1", actor }, {})
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).target).toBe("Calc.divide");
  });

  it("is always on: the deprecated validateFoldedState: false changes nothing", async () => {
    const app = act().withState(calc()).build({ validateFoldedState: false });
    await expect(
      app.do("divide", { stream: "c2", actor }, {})
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("checks the state the action leaves, not the states between its events", async () => {
    // `n` is -1 between the two events, and 1 when the action ends.
    const counter = state({ Counter: z.object({ n: z.number().min(0) }) })
      .init(() => ({ n: 0 }))
      .emits({ moved: z.object({ by: z.number() }) })
      .patch({ moved: (e, s) => ({ n: s.n + e.data.by }) })
      .on({ swap: z.object({}) })
      .emit(() => [
        ["moved", { by: -1 }],
        ["moved", { by: 2 }],
      ])
      .build();
    const app = act().withState(counter).build();
    const snaps = await app.do("swap", { stream: "c4", actor }, {});
    expect(snaps.map((s) => s.state.n)).toEqual([-1, 1]);
  });

  it("checks without replacing the state with the parsed value", async () => {
    const doubled = state({
      Doubled: z.object({ n: z.number().transform((n) => n * 2) }),
    })
      .init(() => ({ n: 0 }))
      .emits({ set: z.object({ n: z.number() }) })
      .on({ set: z.object({ n: z.number() }) })
      .emit("set")
      .build();
    const app = act().withState(doubled).build();
    const [snap] = await app.do("set", { stream: "c5", actor }, { n: 3 });
    expect(snap.state.n).toBe(3);
  });

  it("loads and replays don't check", async () => {
    const app = act().withState(calc()).build();
    // An event already in the store from before the check existed.
    await store().commit("c6", [{ name: "dividedByZero", data: {} }], {
      correlation: "c6",
      causation: {},
    });
    const snap = await app.load("Calc", "c6");
    expect(Number.isNaN(snap.state.result)).toBe(true);
  });

  it("refuses a .nullable() field cleared with null, because the patch deletes the key", async () => {
    // `null` in a patch deletes the key, and `.nullable()` requires it.
    const board = (last: z.ZodType) =>
      state({ Board: z.object({ turn: z.number(), last }) })
        .init(() => ({ turn: 0, last: null }))
        .emits({
          attacked: z.object({ from: z.string() }),
          turned: z.object({}),
        })
        .patch({
          attacked: (e) => ({ last: { from: e.data.from } }),
          turned: (_, s) => ({ turn: s.turn + 1, last: null }),
        })
        .on({ attack: z.object({ from: z.string() }) })
        .emit("attacked")
        .on({ turn: z.object({}) })
        .emit(() => ["turned", {}])
        .build();
    const Last = z.object({ from: z.string() });

    const nullable = act().withState(board(Last.nullable())).build();
    await nullable.do("attack", { stream: "n1", actor }, { from: "a" });
    await expect(
      nullable.do("turn", { stream: "n1", actor }, {})
    ).rejects.toBeInstanceOf(ValidationError);
    const stored = await nullable.query_array({ stream: "n1" });
    expect(stored.map((e) => e.name)).toEqual(["attacked"]);

    const nullish = act().withState(board(Last.nullish())).build();
    await nullish.do("attack", { stream: "n2", actor }, { from: "a" });
    const [snap] = await nullish.do("turn", { stream: "n2", actor }, {});
    expect(snap.state.turn).toBe(1);
    expect("last" in snap.state).toBe(false);
  });

  it("leaves a well-behaved app unchanged", async () => {
    const app = act().withState(calc()).build();
    for (let i = 0; i < 25; i++)
      await app.do("add", { stream: "ok", actor }, { by: 1 });
    const snap = await app.load("Calc", "ok");
    expect(snap.state.result).toBe(25);
  });

  it("refuses with ValidationError when a refinement throws, as a payload's does", async () => {
    const thrower = (on: "state" | "payload") =>
      state({
        T: z.object({ n: z.number() }).refine((s) => {
          if (on === "state" && s.n > 0) throw new Error("boom");
          return true;
        }),
      })
        .init(() => ({ n: 0 }))
        .emits({ bumped: z.object({}) })
        .patch({ bumped: (_, s) => ({ n: s.n + 1 }) })
        .on({
          bump: z.object({ x: z.number() }).refine((p) => {
            if (on === "payload" && p.x > 0) throw new Error("boom");
            return true;
          }),
        })
        .emit(() => ["bumped", {}])
        .build();
    for (const on of ["state", "payload"] as const) {
      const app = act().withState(thrower(on)).build();
      await expect(
        app.do("bump", { stream: `t-${on}`, actor }, { x: 1 })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await app.query_array({ stream: `t-${on}` })).toEqual([]);
    }
  });

  describe("states with sensitive fields", () => {
    const owner = { id: "u1", name: "Owner" };
    const other = { id: "agent", name: "Agent" };

    // The state types the email strictly; only its owner can read it.
    const user = () =>
      state({
        User: z.object({
          email: z.email().optional(),
          contact: z.email().optional(),
          visits: z.number().max(3),
        }),
      })
        .init(() => ({ visits: 0 }))
        .emits({
          registered: z.object({ email: sensitive(z.email()) }),
          registeredWithDomain: z.object({ email: sensitive(z.email()) }),
          visited: z.object({}),
        })
        .patch({
          registered: (e) => ({ email: e.data.email }),
          registeredWithDomain: (e) => ({
            email: e.data.email,
            contact: e.data.email.toLowerCase(),
          }),
          visited: (_, s) => ({ visits: s.visits + 1 }),
        })
        .on({ register: z.object({ email: z.email() }) })
        .emit("registered")
        .on({ registerWithDomain: z.object({ email: z.email() }) })
        .emit("registeredWithDomain")
        .on({ visit: z.object({}) })
        .emit(() => ["visited", {}])
        .discloses((e, a) => a.id === e.stream)
        .build();

    const registered = async (event = "register") => {
      const app = act().withState(user()).build();
      await app.do(
        event as "register",
        { stream: "u1", actor: owner },
        { email: "a@b.co" }
      );
      return app;
    };

    it("ignores a value another actor reads as [REDACTED]", async () => {
      const app = await registered();
      const [snap] = await app.do("visit", { stream: "u1", actor: other }, {});
      expect(snap.state.email).toBe(REDACTED);
      const [own] = await app.do("visit", { stream: "u1", actor: owner }, {});
      expect(own.state).toMatchObject({ email: "a@b.co", visits: 2 });
    });

    it("ignores a forgotten value, so the stream keeps working after forget", async () => {
      const app = await registered();
      await app.forget("u1");
      for (const by of [owner, other]) {
        const [snap] = await app.do("visit", { stream: "u1", actor: by }, {});
        expect(snap.state.email).toBe(SHREDDED);
      }
    });

    it("still refuses a real value that breaks the schema", async () => {
      const app = await registered();
      for (let i = 0; i < 3; i++)
        await app.do("visit", { stream: "u1", actor: owner }, {});
      const caught = await app
        .do("visit", { stream: "u1", actor: other }, {})
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ValidationError);
      const details = String((caught as ValidationError).details);
      expect(details).toContain("visits");
      expect(details).not.toContain("email");
    });

    it("still refuses a field derived from a hidden value", async () => {
      // The reducer lowercases "[REDACTED]", so `contact` is not a marker.
      const app = await registered("registerWithDomain");
      await app.do("visit", { stream: "u1", actor: owner }, {});
      await expect(
        app.do("visit", { stream: "u1", actor: other }, {})
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("checks a marker string in full on a state without sensitive events", async () => {
      const plain = state({ Plain: z.object({ email: z.email().optional() }) })
        .init(() => ({}))
        .emits({ set: z.object({ email: z.string() }) })
        .on({ set: z.object({ email: z.string() }) })
        .emit("set")
        .build();
      const app = act().withState(plain).build();
      await expect(
        app.do("set", { stream: "p1", actor }, { email: REDACTED })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
