import { z } from "zod";
import {
  act,
  dispose,
  InMemoryCache,
  InMemoryStore,
  state,
  ZodEmpty,
} from "../src/index.js";

/**
 * A stream's name can come from caller input, so a default reaction, which
 * reads the stream it reacts to, has to treat any name as a name. Only a source
 * a developer writes can be a pattern.
 */
const actor = { id: "a", name: "a" };
const Thing = state({ Thing: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Done: ZodEmpty })
  .patch({ Done: (_, s) => ({ n: s.n + 1 }) })
  .on({ go: ZodEmpty })
  .emit(() => ["Done", {}])
  .build();

function app_with_default_reaction() {
  const seen: string[] = [];
  const app = act()
    .withState(Thing)
    .on("Done")
    .do(async function record(e, target) {
      seen.push(`${target}<-${e.stream}`);
    })
    .build({
      autoSettle: false,
      scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
    });
  return { app, seen };
}

describe("default reactions on any stream name", () => {
  afterEach(async () => {
    await dispose()();
  });

  it.each([
    "healthy",
    "user+tag@example.com",
    "a.b@example.com",
    "order(1)",
    "a(",
    "[x]",
    "$v",
    "^start",
  ])("delivers %s to itself", async (name) => {
    const { app, seen } = app_with_default_reaction();
    await app.do("go", { stream: name, actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen).toEqual([`${name}<-${name}`]);
  });

  it("never reads a sibling a name would match as a pattern", async () => {
    const { app, seen } = app_with_default_reaction();
    await app.do("go", { stream: "a.b", actor }, {});
    await app.do("go", { stream: "axb", actor }, {});
    await app.do("go", { stream: "a.b.c", actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.sort()).toEqual(["a.b.c<-a.b.c", "a.b<-a.b", "axb<-axb"]);
  });

  it("still reads several streams through a pattern a developer wrote", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Done")
      .do(async function board(e) {
        seen.push(e.stream);
      })
      .to({ target: "Board", source: "^(A|B)$" })
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    for (const stream of ["A", "B", "C"])
      await app.do("go", { stream, actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen).toEqual(["A", "B"]);
  });

  it("a close waits for a default reaction still behind on such a name", async () => {
    const { app, seen } = app_with_default_reaction();
    await app.do("go", { stream: "user+tag", actor }, {});
    await app.correlate();
    const result = await app.close([{ stream: "user+tag" }]);
    expect(result.skipped).toEqual(["user+tag"]);
    expect(seen).toEqual([]);

    await app.drain();
    expect(seen).toEqual(["user+tag<-user+tag"]);
    expect((await app.close([{ stream: "user+tag" }])).skipped).toEqual([]);
  });

  it("a close waits for reactions reading through a written pattern", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Done")
      .do(async function one(e) {
        seen.push(`one:${e.stream}`);
      })
      .to({ target: "one", source: "^(A|B)$" })
      .on("Done")
      .do(async function two(e) {
        seen.push(`two:${e.stream}`);
      })
      .to({ target: "two", source: "^(A|B)$" })
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    for (const stream of ["A", "B", "C"])
      await app.do("go", { stream, actor }, {});
    await app.correlate();

    const behind = await app.close([{ stream: "A" }, { stream: "B" }]);
    expect(behind.skipped.sort()).toEqual(["A", "B"]);
    expect((await app.close([{ stream: "C" }])).skipped).toEqual([]);

    await app.drain();
    expect(seen).toHaveLength(4);
    const caught_up = await app.close([{ stream: "A" }, { stream: "B" }]);
    expect(caught_up.skipped).toEqual([]);
  });

  it("a name that can't compile as a pattern doesn't break a close elsewhere", async () => {
    const { app } = app_with_default_reaction();
    await app.do("go", { stream: "a(", actor }, {});
    await app.do("go", { stream: "other", actor }, {});
    await app.correlate();
    await app.drain();
    const result = await app.close([{ stream: "other" }]);
    expect(result.truncated.has("other")).toBe(true);
  });

  it("reads a written source as a name unless it's anchored", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Done")
      .do(async function exact(e) {
        seen.push(`exact:${e.stream}`);
      })
      .to({ target: "exact", source: "a+b" })
      .on("Done")
      .do(async function unanchored(e) {
        seen.push(`unanchored:${e.stream}`);
      })
      .to({ target: "unanchored", source: "order-.*" })
      .on("Done")
      .do(async function anchored(e) {
        seen.push(`anchored:${e.stream}`);
      })
      .to({ target: "anchored", source: "^order-" })
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    for (const stream of ["a+b", "aab", "order-1"])
      await app.do("go", { stream, actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.sort()).toEqual(["anchored:order-1", "exact:a+b"]);
  });

  it("delivers a dynamic reaction whose source is any stream's name", async () => {
    const seen: string[] = [];
    const app = act()
      .withState(Thing)
      .on("Done")
      .do(async function copy(e, target) {
        seen.push(`${target}<-${e.stream}`);
      })
      .to((e) => ({ target: `copy-${e.stream}`, source: e.stream }))
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    await app.do("go", { stream: "user+tag", actor }, {});
    await app.do("go", { stream: "healthy", actor }, {});
    await app.correlate();
    await app.drain();
    expect(seen.sort()).toEqual([
      "copy-healthy<-healthy",
      "copy-user+tag<-user+tag",
    ]);
  });
});
