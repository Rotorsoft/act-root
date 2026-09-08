import { z } from "zod";
import {
  act,
  ConcurrencyError,
  sensitive,
  state,
  ZodEmpty,
} from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { Store } from "../src/types/index.js";

describe("partial-state", () => {
  const schema = z.object({
    count: z.number(),
    label: z.string(),
  });

  // Cross-slice event schemas are reference-identity checked (ACT-401).
  // Hoist any event schema shared between partials to a single instance.
  const Incremented = z.object({ by: z.number() });

  const PartA = state({ Thing: schema })
    .init(() => ({ count: 0, label: "" }))
    .emits({ Incremented })
    .patch({
      Incremented: (event, state) => ({ count: state.count + event.data.by }),
    })
    .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { by: action.by }])
    .build();

  const PartB = state({ Thing: schema })
    .init(() => ({ count: 0, label: "" }))
    .emits({ Labeled: z.object({ label: z.string() }) })
    .patch({
      Labeled: (event) => ({ label: event.data.label }),
    })
    .on({ setLabel: z.object({ label: z.string() }) })
    .emit((action) => ["Labeled", { label: action.label }])
    .build();

  const actor = { id: "a", name: "a" };

  it("should merge two partials with the same name", async () => {
    const { app, dispose } = await sandbox(
      act().withState(PartA).withState(PartB)
    );
    expect(app).toBeDefined();
    await dispose();
  });

  it("should execute actions from both partials", async () => {
    const { app, dispose } = await sandbox(
      act().withState(PartA).withState(PartB)
    );

    await app.do("increment", { stream: "s1", actor }, { by: 3 });
    await app.do("setLabel", { stream: "s1", actor }, { label: "hello" });

    const snap = await app.load(PartA, "s1");
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("hello");

    await dispose();
  });

  it("should reconstruct state from events across all partials", async () => {
    const { app, dispose } = await sandbox(
      act().withState(PartA).withState(PartB)
    );

    await app.do("increment", { stream: "s2", actor }, { by: 1 });
    await app.do("setLabel", { stream: "s2", actor }, { label: "first" });
    await app.do("increment", { stream: "s2", actor }, { by: 2 });
    await app.do("setLabel", { stream: "s2", actor }, { label: "second" });

    const snap = await app.load(PartA, "s2");
    expect(snap.state.count).toBe(3);
    expect(snap.state.label).toBe("second");

    await dispose();
  });

  it("should throw on duplicate action across partials", () => {
    const DupAction = state({ Thing: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Other: ZodEmpty })
      .patch({ Other: () => ({}) })
      .on({ increment: ZodEmpty })
      .emit(() => ["Other", {}])
      .build();

    expect(() => act().withState(PartA).withState(DupAction)).toThrow(
      'Duplicate action "increment"'
    );
  });

  it("should throw on conflicting custom patches for same event across partials", () => {
    const DupEvent = state({ Thing: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Incremented })
      .patch({ Incremented: () => ({}) })
      .on({ other: ZodEmpty })
      .emit(() => ["Incremented", { by: 0 }])
      .build();

    expect(() => act().withState(PartA).withState(DupEvent)).toThrow(
      'Duplicate custom patch for event "Incremented" in state "Thing"'
    );
  });

  it("should support reactions on events from any partial", async () => {
    const onIncremented = vi.fn().mockResolvedValue(undefined);
    const onLabeled = vi.fn().mockResolvedValue(undefined);

    const { app, dispose } = await sandbox(
      act()
        .withState(PartA)
        .on("Incremented")
        .do(onIncremented)
        .withState(PartB)
        .on("Labeled")
        .do(onLabeled)
    );

    await app.do("increment", { stream: "s3", actor }, { by: 1 });
    await app.do("setLabel", { stream: "s3", actor }, { label: "test" });
    await app.correlate();
    await app.drain();

    expect(onIncremented).toHaveBeenCalled();
    expect(onLabeled).toHaveBeenCalled();

    await dispose();
  });

  it("should preserve snap from partial that defines it", async () => {
    const WithSnap = state({ Snapped: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["X", {}])
      .snap(() => true)
      .build();

    const WithoutSnap = state({ Snapped: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["Y", {}])
      .build();

    const { app, dispose } = await sandbox(
      act().withState(WithSnap).withState(WithoutSnap)
    );
    expect(app).toBeDefined();
    await dispose();
  });

  it("should throw on conflicting snap strategies", () => {
    const Snap1 = state({ Snapped: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["X", {}])
      .snap(() => true)
      .build();

    const Snap2 = state({ Snapped: schema })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["Y", {}])
      .snap(() => false)
      .build();

    expect(() => act().withState(Snap1).withState(Snap2).build()).toThrow(
      'Duplicate snap strategy for state "Snapped"'
    );
  });

  it("should work with single-chain states (backward compat)", async () => {
    const counter = state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ incremented: ZodEmpty })
      .patch({ incremented: (_, state) => ({ count: state.count + 1 }) })
      .on({ increment: ZodEmpty })
      .emit(() => ["incremented", {}])
      .build();

    const { app, dispose } = await sandbox(act().withState(counter));
    await app.do("increment", { stream: "compat1", actor }, {});
    const snap = await app.load(counter, "compat1");
    expect(snap.state.count).toBe(1);

    await dispose();
  });

  it("should load merged state by name", async () => {
    const { app, dispose } = await sandbox(
      act().withState(PartA).withState(PartB)
    );

    await app.do("increment", { stream: "n1", actor }, { by: 7 });
    await app.do("setLabel", { stream: "n1", actor }, { label: "byname" });

    const snap = await app.load("Thing", "n1");
    expect(snap.state.count).toBe(7);
    expect(snap.state.label).toBe("byname");

    await dispose();
  });

  it("should throw when loading unknown state by name", async () => {
    const { app, dispose } = await sandbox(act().withState(PartA));
    // @ts-expect-error "Unknown" is not a registered state name
    await expect(app.load("Unknown", "s1")).rejects.toThrow(
      'State "Unknown" not found'
    );
    await dispose();
  });

  it("should merge partial schemas with non-overlapping fields", async () => {
    const PartialA = state({ Merged: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Counted: z.object({ n: z.number() }) })
      .patch({ Counted: (e) => ({ count: e.data.n }) })
      .on({ setCount: z.object({ n: z.number() }) })
      .emit((a) => ["Counted", { n: a.n }])
      .build();

    const PartialB = state({ Merged: z.object({ label: z.string() }) })
      .init(() => ({ label: "" }))
      .emits({ Named: z.object({ label: z.string() }) })
      .patch({ Named: (e) => ({ label: e.data.label }) })
      .on({ setName: z.object({ label: z.string() }) })
      .emit((a) => ["Named", { label: a.label }])
      .build();

    const { app, dispose } = await sandbox(
      act().withState(PartialA).withState(PartialB)
    );

    await app.do("setCount", { stream: "m1", actor }, { n: 42 });
    await app.do("setName", { stream: "m1", actor }, { label: "hello" });

    const snap = await app.load("Merged", "m1");
    expect(snap.state.count).toBe(42);
    expect(snap.state.label).toBe("hello");

    await dispose();
  });

  it("should merge init functions from partials", async () => {
    const PartialA = state({ InitMerge: z.object({ x: z.number() }) })
      .init(() => ({ x: 10 }))
      .emits({ A: ZodEmpty })
      .patch({ A: () => ({}) })
      .on({ doA: ZodEmpty })
      .emit(() => ["A", {}])
      .build();

    const PartialB = state({ InitMerge: z.object({ y: z.string() }) })
      .init(() => ({ y: "default" }))
      .emits({ B: ZodEmpty })
      .patch({ B: () => ({}) })
      .on({ doB: ZodEmpty })
      .emit(() => ["B", {}])
      .build();

    const { app, dispose } = await sandbox(
      act().withState(PartialA).withState(PartialB)
    );
    await app.do("doA", { stream: "i1", actor }, {});
    const snap = await app.load("InitMerge", "i1");
    expect(snap.state.x).toBe(10);
    expect(snap.state.y).toBe("default");

    await dispose();
  });

  it("should allow overlapping keys with same base type", () => {
    const PartialA = state({ Overlap: z.object({ shared: z.string() }) })
      .init(() => ({ shared: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["X", {}])
      .build();

    const PartialB = state({
      Overlap: z.object({ shared: z.string().optional() }),
    })
      .init(() => ({ shared: undefined }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["Y", {}])
      .build();

    expect(() => act().withState(PartialA).withState(PartialB)).not.toThrow();
  });

  it("should throw on overlapping keys with different base types", () => {
    const PartialA = state({ Conflict: z.object({ field: z.string() }) })
      .init(() => ({ field: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["X", {}])
      .build();

    const PartialB = state({ Conflict: z.object({ field: z.number() }) })
      .init(() => ({ field: 0 }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["Y", {}])
      .build();

    expect(() => act().withState(PartialA).withState(PartialB)).toThrow(
      "Schema conflict"
    );
  });

  it("should reconstruct state from cross-partial events", async () => {
    const PartialA = state({ Cross: z.object({ total: z.number() }) })
      .init(() => ({ total: 0 }))
      .emits({ Added: z.object({ n: z.number() }) })
      .patch({ Added: (e, s) => ({ total: s.total + e.data.n }) })
      .on({ add: z.object({ n: z.number() }) })
      .emit((a) => ["Added", { n: a.n }])
      .build();

    const PartialB = state({ Cross: z.object({ tag: z.string() }) })
      .init(() => ({ tag: "" }))
      .emits({ Tagged: z.object({ tag: z.string() }) })
      .patch({ Tagged: (e) => ({ tag: e.data.tag }) })
      .on({ tag: z.object({ tag: z.string() }) })
      .emit((a) => ["Tagged", { tag: a.tag }])
      .build();

    const { app, dispose } = await sandbox(
      act().withState(PartialA).withState(PartialB)
    );
    await app.do("add", { stream: "c1", actor }, { n: 1 });
    await app.do("tag", { stream: "c1", actor }, { tag: "a" });
    await app.do("add", { stream: "c1", actor }, { n: 2 });
    await app.do("tag", { stream: "c1", actor }, { tag: "b" });

    const snap = await app.load("Cross", "c1");
    expect(snap.state.total).toBe(3);
    expect(snap.state.tag).toBe("b");

    await dispose();
  });

  it("should not conflict on optional wrapping of same base type", () => {
    const PartialA = state({ OptWrap: z.object({ val: z.string() }) })
      .init(() => ({ val: "" }))
      .emits({ X: ZodEmpty })
      .patch({ X: () => ({}) })
      .on({ doX: ZodEmpty })
      .emit(() => ["X", {}])
      .build();

    const PartialB = state({
      OptWrap: z.object({ val: z.string().optional() }),
    })
      .init(() => ({ val: undefined }))
      .emits({ Y: ZodEmpty })
      .patch({ Y: () => ({}) })
      .on({ doY: ZodEmpty })
      .emit(() => ["Y", {}])
      .build();

    expect(() => act().withState(PartialA).withState(PartialB)).not.toThrow();
  });

  describe("patch merge priority (passthrough vs custom)", () => {
    const ListArchived = z.object({ reason: z.string() });

    it("should keep custom patch when existing is passthrough", async () => {
      const AutoArchive = state({
        TodoList: z.object({ status: z.string() }),
      })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({
          ListArchived: () => ({ status: "archived" }),
        })
        .on({ archiveList: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      const Audit = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .on({ auditList: z.object({ note: z.string() }) })
        .emit(() => ["ListArchived", { reason: "audit" }])
        .build();

      const { app, dispose } = await sandbox(
        act().withState(AutoArchive).withState(Audit)
      );
      await app.do("archiveList", { stream: "t1", actor }, { reason: "done" });
      const snap = await app.load("TodoList", "t1");
      expect(snap.state.status).toBe("archived");

      await dispose();
    });

    it("should keep custom patch when incoming is passthrough (reverse order)", async () => {
      const Audit = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .on({ auditList: z.object({ note: z.string() }) })
        .emit(() => ["ListArchived", { reason: "audit" }])
        .build();

      const AutoArchive = state({
        TodoList: z.object({ status: z.string() }),
      })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({
          ListArchived: () => ({ status: "archived" }),
        })
        .on({ archiveList: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      const { app, dispose } = await sandbox(
        act().withState(Audit).withState(AutoArchive)
      );
      await app.do("archiveList", { stream: "t2", actor }, { reason: "done" });
      const snap = await app.load("TodoList", "t2");
      expect(snap.state.status).toBe("archived");

      await dispose();
    });

    it("should allow same function reference (re-registration from another slice)", () => {
      const customPatch = () => ({ status: "archived" });
      const PartA = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({ ListArchived: customPatch })
        .on({ archiveA: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      const PartB = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({ ListArchived: customPatch })
        .on({ archiveB: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      expect(() => act().withState(PartA).withState(PartB)).not.toThrow();
    });

    it("should throw when partial redeclares an event owned by a different state", () => {
      const Other = state({ Other: z.object({}) })
        .init(() => ({}))
        .emits({ Shared: z.object({}) })
        .on({ doOther: z.object({}) })
        .emit("Shared")
        .build();

      const PartA = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ Done: z.object({}) })
        .on({ finish: z.object({}) })
        .emit("Done")
        .build();

      const PartB = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ Shared: z.object({}) })
        .on({ reuse: z.object({}) })
        .emit("Shared")
        .build();

      expect(() =>
        act().withState(Other).withState(PartA).withState(PartB)
      ).toThrow('Duplicate event "Shared"');
    });

    it("should throw on two different custom patches for the same event", () => {
      const PartA = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({ ListArchived: () => ({ status: "archived" }) })
        .on({ archiveA: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      const PartB = state({ TodoList: z.object({ status: z.string() }) })
        .init(() => ({ status: "active" }))
        .emits({ ListArchived })
        .patch({ ListArchived: () => ({ status: "deleted" }) })
        .on({ archiveB: z.object({ reason: z.string() }) })
        .emit((a) => ["ListArchived", { reason: a.reason }])
        .build();

      expect(() => act().withState(PartA).withState(PartB)).toThrow(
        'Duplicate custom patch for event "ListArchived" in state "TodoList"'
      );
    });
  });

  it("should merge given (invariants) from partials", async () => {
    const PartWithInvariant = state({
      Guarded: z.object({ locked: z.boolean() }),
    })
      .init(() => ({ locked: false }))
      .emits({ Locked: ZodEmpty })
      .patch({ Locked: () => ({ locked: true }) })
      .on({ lock: ZodEmpty })
      .emit(() => ["Locked", {}])
      .build();

    const PartWithGuardedAction = state({
      Guarded: z.object({ locked: z.boolean() }),
    })
      .init(() => ({ locked: false }))
      .emits({ Attempted: ZodEmpty })
      .patch({ Attempted: () => ({}) })
      .on({ attempt: ZodEmpty })
      .given([{ description: "Must not be locked", valid: (s) => !s.locked }])
      .emit(() => ["Attempted", {}])
      .build();

    const { app, dispose } = await sandbox(
      act().withState(PartWithInvariant).withState(PartWithGuardedAction)
    );

    await app.do("lock", { stream: "g1", actor }, {});
    await expect(
      app.do("attempt", { stream: "g1", actor }, {})
    ).rejects.toThrow("Must not be locked");

    await dispose();
  });
});

/**
 * `merge_into_existing` spreads `existing` and then re-lists the fields it
 * merges, so anything missing from that list silently kept the FIRST
 * partial's value and discarded the incoming one (#1645). These cover the
 * fields that were missing: per-action `options`, and the single-declaration
 * policies `disclose` / `autoclose` (+ its day fields) / `archive`.
 */
describe("partial-state — policies declared on a later partial (#1645)", () => {
  const actor = { id: "a", name: "a" };
  const Ticket = z.object({ open: z.boolean() });
  const Opened = ZodEmpty;
  const Resolved = ZodEmpty;

  /** A partial carrying no policy of its own, to register alongside. */
  const plain = () =>
    state({ Tkt: Ticket })
      .init(() => ({ open: false }))
      .emits({ Opened })
      .patch({ Opened: () => ({ open: true }) })
      .on({ open: ZodEmpty })
      .emit(() => ["Opened", {}])
      .build();

  /** The policy-bearing partial. Identical in every test; only its
   *  registration ORDER varies, which is what the bug was sensitive to. */
  const base = () =>
    state({ Tkt: Ticket })
      .init(() => ({ open: false }))
      .emits({ Resolved })
      .patch({ Resolved: () => ({ open: false }) })
      .on({ resolve: ZodEmpty }, { maxRetries: 2 });

  it("carries per-action options from a later partial into the retry loop", async () => {
    const with_retry = base()
      .emit(() => ["Resolved", {}])
      .build();
    // The options-bearing partial is registered SECOND.
    const { app, store, dispose } = await sandbox(
      act().withState(plain()).withState(with_retry)
    );
    const original = store.commit.bind(store);
    let thrown = false;
    store.commit = (async (...args: Parameters<Store["commit"]>) => {
      if (!thrown) {
        thrown = true;
        throw new ConcurrencyError(args[0] as string, 0, [], 0);
      }
      return original(...args);
    }) as Store["commit"];

    // Without the merge fix `max_retries` falls back to 0 and this rejects.
    await expect(
      app.do("resolve", { stream: "t1", actor }, {})
    ).resolves.toBeDefined();

    store.commit = original;
    await dispose();
  });

  it("combines the per-action options maps of both partials", async () => {
    const a = state({ Tkt: Ticket })
      .init(() => ({ open: false }))
      .emits({ Opened })
      .patch({ Opened: () => ({ open: true }) })
      .on({ open: ZodEmpty }, { maxRetries: 1 })
      .emit(() => ["Opened", {}])
      .build();
    const b = base()
      .emit(() => ["Resolved", {}])
      .build();
    const { app, dispose } = await sandbox(act().withState(a).withState(b));
    // Both actions resolve through their own options entry.
    await app.do("open", { stream: "t2", actor }, {});
    await app.do("resolve", { stream: "t2", actor }, {});
    await dispose();
  });

  it("carries a disclosure predicate from a later partial", async () => {
    const Secret = z.object({ email: sensitive(z.string()) });
    const a = state({ Sec: z.object({ email: z.string() }) })
      .init(() => ({ email: "" }))
      .emits({ Noted: ZodEmpty })
      .patch({ Noted: () => ({}) })
      .on({ note: ZodEmpty })
      .emit(() => ["Noted", {}])
      .build();
    const b = state({ Sec: z.object({ email: z.string() }) })
      .init(() => ({ email: "" }))
      .emits({ Registered: Secret })
      .patch({ Registered: ({ data }) => ({ email: data.email }) })
      .on({ register: Secret })
      .emit((p) => ["Registered", p])
      .discloses(() => true)
      .build();

    // Predicate-bearing partial registered SECOND: without the fix the
    // merged state default-denies and the actor reads "[REDACTED]".
    const { app, dispose } = await sandbox(act().withState(a).withState(b));
    const snaps = await app.do(
      "register",
      { stream: "s1", actor },
      { email: "u@example.com" }
    );
    expect(snaps.at(-1)?.state.email).toBe("u@example.com");
    await dispose();
  });

  it("carries an autoclose policy and its day fields from a later partial", async () => {
    const closing = base()
      .emit(() => ["Resolved", {}])
      .snap(() => true)
      .autocloses({ keep: { days: 7 } })
      .build();
    const app = act().withState(plain()).withState(closing).build();
    expect(app.registry.autoclose_policy("Tkt")).toBeTruthy();
  });

  it("carries an archiver from a later partial", () => {
    const archive = async () => {};
    const archiving = base()
      .emit(() => ["Resolved", {}])
      .autocloses({ is: "Resolved" })
      .archives(archive)
      .build();
    const app = act().withState(plain()).withState(archiving).build();
    expect(app.registry.autoclose_archiver("Tkt")).toBe(archive);
  });

  it("leaves options undefined when neither partial declared any", () => {
    const app = act()
      .withState(plain())
      .withState(
        base()
          .emit(() => ["Resolved", {}])
          .build()
      )
      .build();
    expect(app.registry.autoclose_policy("Tkt")).toBeFalsy();
  });

  describe("two conflicting declarations are a conflict, not first-wins", () => {
    const other = (build: (b: any) => any) =>
      build(
        state({ Tkt: Ticket })
          .init(() => ({ open: false }))
          .emits({ Opened })
          .patch({ Opened: () => ({ open: true }) })
          .on({ open: ZodEmpty })
          .emit(() => ["Opened", {}])
      ).build();

    it("throws on two disclosure predicates", () => {
      const a = other((b: any) => b.discloses(() => true));
      const c = base()
        .emit(() => ["Resolved", {}])
        .discloses(() => false)
        .build();
      expect(() => act().withState(a).withState(c).build()).toThrow(
        'Duplicate disclosure predicate for state "Tkt"'
      );
    });

    it("throws on two archivers", () => {
      const a = other((b: any) =>
        b.autocloses({ is: "Opened" }).archives(async () => {})
      );
      const c = base()
        .emit(() => ["Resolved", {}])
        .autocloses({ is: "Resolved" })
        .archives(async () => {})
        .build();
      expect(() => act().withState(a).withState(c).build()).toThrow(
        /Duplicate (archiver|autoclose policy) for state "Tkt"/
      );
    });

    it("throws on two autoclose policies", () => {
      const a = other((b: any) => b.autocloses({ is: "Opened" }));
      const c = base()
        .emit(() => ["Resolved", {}])
        .autocloses({ is: "Resolved" })
        .build();
      expect(() => act().withState(a).withState(c).build()).toThrow(
        'Duplicate autoclose policy for state "Tkt"'
      );
    });
  });
});
