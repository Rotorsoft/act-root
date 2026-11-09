/**
 * A store written for the commit before 2.0 is refused when it's injected. Left
 * alone, a wrapper of that shape forwards its arguments, so commits work, then
 * sends the appends, sensitive fields included, wherever it sends a stream name.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  type Store,
  state,
  store,
  ZodEmpty,
} from "../src/index.js";

const before_2_0 = () => {
  const real = new InMemoryStore();
  const commit = (
    stream: unknown,
    msgs: unknown,
    meta: unknown,
    version: unknown
  ) =>
    (real.commit as (...a: unknown[]) => unknown)(stream, msgs, meta, version);
  return Object.assign(real, { commit }) as unknown as Store;
};

const Thing = state({ Thing: z.object({}) })
  .init(() => ({}))
  .emits({ Happened: ZodEmpty })
  .build();

describe("a store shaped for 1.x", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("is refused when injected", () => {
    expect(() => store(before_2_0())).toThrow(/before @rotorsoft\/act 2\.0/);
  });

  it("is refused in a scoped Act", () => {
    expect(() =>
      act()
        .withState(Thing)
        .build({
          scoped: { store: before_2_0(), cache: new InMemoryCache() },
        })
    ).toThrow(/before @rotorsoft\/act 2\.0/);
  });

  it("lets a current store through", () => {
    const current = new InMemoryStore();
    expect(store(current)).toBe(current);
  });

  it("lets a wrapper it can't read through", () => {
    const real = new InMemoryStore();
    const wrapped = Object.assign(new InMemoryStore(), {
      commit: (...args: Parameters<Store["commit"]>) => real.commit(...args),
    }) as Store;
    expect(store(wrapped)).toBe(wrapped);
  });
});
