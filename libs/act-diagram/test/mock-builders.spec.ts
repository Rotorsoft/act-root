import { describe, expect, it } from "vitest";
import {
  mockAct,
  mockProjection,
  mockSlice,
  mockState,
  MODULES,
  unknownModuleProxy,
} from "../src/client/lib/mock-builders.js";

describe("mockState", () => {
  it("captures state name and events", () => {
    const built: any[] = [];
    const builder = mockState({ Counter: {} }, (info) => built.push(info));
    builder
      .init(() => ({}))
      .emits({ Incremented: {} })
      .on({ increment: {} })
      .emit("Incremented")
      .build();

    expect(built).toHaveLength(1);
    expect(built[0].name).toBe("Counter");
    expect(built[0]._tag).toBe("State");
    expect(built[0].events).toHaveProperty("Incremented");
    expect(built[0].actions).toHaveProperty("increment");
    expect(built[0].actions.__emits_increment).toEqual(["Incremented"]);
  });

  it("captures patches", () => {
    const built: any[] = [];
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ E1: {} })
      .patch({ E1: () => ({}) })
      .on({ doIt: {} })
      .emit("E1")
      .build();

    expect(built[0].patches.has("E1")).toBe(true);
  });

  it("captures given invariants", () => {
    const built: any[] = [];
    const inv = { description: "must be open", valid: () => true };
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ Done: {} })
      .on({ doIt: {} })
      .given([inv])
      .emit("Done")
      .build();

    expect(built[0].given.doIt).toEqual([inv]);
  });

  it("handles snap() in chain", () => {
    const built: any[] = [];
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ Done: {} })
      .on({ doIt: {} })
      .emit("Done")
      .snap()
      .build();

    expect(built).toHaveLength(1);
  });

  it("handles emits(undefined) gracefully", () => {
    const built: any[] = [];
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits(undefined as unknown as Record<string, any>)
      .build();

    expect(built[0].events).toEqual({});
  });

  it("builds without onBuild callback", () => {
    const result = mockState({ S: {} })
      .init()
      .emits({ E: {} })
      .on({ a: {} })
      .emit("E")
      .build();
    expect(result._tag).toBe("State");
  });

  it("handles emit with function handler that references events by string", () => {
    const built: any[] = [];
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ Created: {}, Updated: {} })
      .on({ create: {} })
      .emit((action: any) => ["Created", { v: action.v }])
      .build();

    // Strategy 2 (proxy execution) should capture "Created"
    expect(built[0].actions.__emits_create).toContain("Created");
  });

  it("exercises proxy traps directly in attachEmit Strategy 2", () => {
    // Build a state where the handler function body has no string references
    // to event names, forcing proxy execution path
    const built: any[] = [];
    const events = { MyEvt: {} };

    // Use mockState directly, set events, then call emit with a handler
    // that returns ["MyEvt", data] through proxy interaction
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits(events)
      .on({ action1: {} })
      .emit(function handler(arg: any) {
        // Access arg properties to trigger dummyArg.get → proxyFn
        const val = arg.someProperty;
        // Call proxyFn to trigger proxyFn.apply → deepProxy
        const result = val("test");
        // Access deepProxy to trigger deepProxy.get
        const nested = result.deep;
        // Check 'in' to trigger deepProxy.has
        if ("x" in nested) {
          void nested;
        }
        // Return array with event name from actual events object
        return ["MyEvt", {}];
      })
      .build();

    expect(built[0].actions.__emits_action1).toContain("MyEvt");
  });

  it("handles emit with function that accesses event properties via proxy", () => {
    const built: any[] = [];
    // This handler accesses action properties via proxy args, triggering
    // deepProxy.get, deepProxy.apply, deepProxy.has, dummyArg.get, proxyFn.get
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ Created: {} })
      .on({ create: {} })
      .emit((action: any) => {
        // Access properties to exercise the proxy paths
        const v = action.something;
        const r = v.nested.deep();
        if ("key" in action) {
          return ["Created", { result: r }];
        }
        return ["Created", {}];
      })
      .build();

    expect(built[0].actions.__emits_create).toContain("Created");
  });

  it("handles emit with function handler via proxy execution (no string match)", () => {
    const built: any[] = [];
    // Handler returns array but event name is NOT in events, so string search fails
    // Proxy execution path runs: handler(dummyArg, dummyArg, dummyArg)
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ Alpha: {} })
      .on({ doIt: {} })
      .emit(() => {
        // This handler references no event names as strings,
        // so proxy execution kicks in but returns non-array
        return { something: "else" };
      })
      .build();

    // Proxy tried but result is not an array, so emits stays empty
    expect(built[0].actions.__emits_doIt).toEqual([]);
  });

  it("handles emit with function that throws during proxy execution", () => {
    const built: any[] = [];
    mockState({ S: {} }, (info) => built.push(info))
      .init()
      .emits({ E1: {} })
      .on({ doIt: {} })
      .emit(() => {
        throw new Error("boom");
      })
      .build();

    // Should not crash, emits stays empty
    expect(built[0].actions.__emits_doIt).toEqual([]);
  });
});

describe("mockSlice", () => {
  it("captures states and projections", () => {
    const built: any[] = [];
    const fakeState = { _tag: "State", name: "S" };
    const fakeProj = { _tag: "Projection", target: "p" };
    mockSlice((info) => built.push(info))
      .withState(fakeState)
      .withProjection(fakeProj)
      .build();

    expect(built[0]._tag).toBe("Slice");
    expect(built[0].states).toContain(fakeState);
    expect(built[0].projections).toContain(fakeProj);
  });

  it("captures reactions with .to()", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("SomeEvent")
      .do(async function handler() {})
      .to(() => "target")
      .build();

    expect(built[0].reactions).toHaveLength(1);
    expect(built[0].reactions[0].isVoid).toBe(false);
    expect(built[0].reactions[0].handlerName).toBe("handler");
  });

  it("captures reactions with .void()", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("SomeEvent")
      .do(async function sideEffect() {})
      .void()
      .build();

    expect(built[0].reactions[0].isVoid).toBe(true);
  });

  it("captures anonymous reaction handlers", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("Evt")
      .do(async () => {})
      .to(() => "x")
      .build();

    expect(built[0].reactions[0].handlerName).toBe("on Evt");
  });

  it("captures dispatches via regex fallback for conditional handlers", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("Evt")
      .do(function conditionalHandler(_event: any, _stream: any, app: any) {
        if (Math.random() > 2) {
          // unreachable, but source contains the string
          app.do("DispatchedAction", "stream", {});
        }
      })
      .to(() => "x")
      .build();

    // Runtime won't hit the dispatch, but regex fallback should find it
    expect(built[0].reactions[0].dispatches).toContain("DispatchedAction");
  });

  it("captureDispatches returns empty for non-function handler", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("Evt")
      .do("not a function" as any)
      .to(() => "x")
      .build();

    expect(built[0].reactions[0].dispatches).toEqual([]);
  });

  it("captureDispatches exercises event.data proxy path", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("Evt")
      .do(async function dataAccessor(event: any, _stream: any, app: any) {
        // Access event.data to trigger the data proxy
        const val = event.data.someField;
        await app.do("ActionFromData", "stream", { v: val });
      })
      .to(() => "x")
      .build();

    expect(built[0].reactions[0].dispatches).toContain("ActionFromData");
  });

  it("captureDispatches handles handler that throws", () => {
    const built: any[] = [];
    mockSlice((info) => built.push(info))
      .on("Evt")
      .do(function thrower() {
        throw new Error("sync throw");
      })
      .to(() => "x")
      .build();

    // Should not crash
    expect(built[0].reactions[0].dispatches).toEqual([]);
  });
});

describe("mockProjection", () => {
  it("captures event handles", () => {
    const built: any[] = [];
    mockProjection("myProj", (info) => built.push(info))
      .on({ EventA: {} })
      .do()
      .on({ EventB: {} })
      .do()
      .build();

    expect(built[0].target).toBe("myProj");
    expect(built[0].handles).toEqual(["EventA", "EventB"]);
  });

  it("uses default target when none provided", () => {
    const built: any[] = [];
    mockProjection(undefined, (info) => built.push(info)).build();
    expect(built[0].target).toBe("projection");
  });

  it(".to() with string resolver updates target", () => {
    const built: any[] = [];
    mockProjection("initial", (info) => built.push(info))
      .on({ Evt: {} })
      .do()
      .to("newTarget")
      .build();

    expect(built[0].target).toBe("newTarget");
  });

  it(".to() with non-string resolver keeps target unchanged", () => {
    const built: any[] = [];
    mockProjection("initial", (info) => built.push(info))
      .on({ Evt: {} })
      .do()
      .to(() => "fn")
      .build();

    expect(built[0].target).toBe("initial");
  });

  it(".void() chains back to builder", () => {
    const built: any[] = [];
    mockProjection("p", (info) => built.push(info))
      .on({ E1: {} })
      .do()
      .void()
      .on({ E2: {} })
      .do()
      .build();

    expect(built[0].handles).toEqual(["E1", "E2"]);
  });
});

describe("mockAct", () => {
  it("captures states, slices, projections", () => {
    const built: any[] = [];
    const fakeState = { _tag: "State", name: "S" };
    const fakeSlice = { _tag: "Slice", states: [] };
    const fakeProj = { _tag: "Projection", target: "p" };
    mockAct((info) => built.push(info))
      .withState(fakeState)
      .withSlice(fakeSlice)
      .withProjection(fakeProj)
      .withActor()
      .build();

    expect(built[0]._tag).toBe("Act");
    expect(built[0].states).toContain(fakeState);
    expect(built[0].slices).toContain(fakeSlice);
    expect(built[0].projections).toContain(fakeProj);
  });

  it("captures reactions with .to() and .void()", () => {
    const built: any[] = [];
    mockAct((info) => built.push(info))
      .on("E1")
      .do(async function r1() {})
      .to(() => "t")
      .on("E2")
      .do(async function r2() {})
      .void()
      .build();

    expect(built[0].reactions).toHaveLength(2);
    expect(built[0].reactions[0].isVoid).toBe(false);
    expect(built[0].reactions[1].isVoid).toBe(true);
  });

  it("build returns an act stub with all expected methods", () => {
    const result = mockAct().build();
    expect(typeof result.do).toBe("function");
    expect(typeof result.load).toBe("function");
    expect(typeof result.drain).toBe("function");
    expect(typeof result.correlate).toBe("function");
    expect(typeof result.settle).toBe("function");
    expect(typeof result.start_correlations).toBe("function");
    expect(typeof result.query_array).toBe("function");
    expect(typeof result.on).toBe("function");
  });

  it("act stub .on() returns itself for chaining", () => {
    const stub = mockAct().build();
    expect(stub.on("x")).toBe(stub);
  });

  it("act stub methods return expected values", async () => {
    const stub = mockAct().build();
    expect(await stub.do()).toEqual([]);
    expect(await stub.load()).toEqual({});
    expect(await stub.drain()).toBeUndefined();
    expect(await stub.correlate()).toEqual({ subscribed: 0, last_id: 0 });
    expect(await stub.query_array()).toEqual([]);
    // settle and start_correlations return the stub (noop)
    expect(stub.settle()).toBe(stub);
    expect(stub.start_correlations()).toBe(stub);
  });
});

describe("unknownModuleProxy", () => {
  it("property access returns the proxy", () => {
    const proxy = unknownModuleProxy();
    expect(typeof (proxy as any).anything).toBe("function");
    expect(typeof (proxy as any).nested.deep).toBe("function");
  });

  it("function call returns the proxy", () => {
    const proxy = unknownModuleProxy();
    const result = (proxy as any).foo();
    expect(typeof result).toBe("function");
  });

  it("constructor call returns the proxy", () => {
    const proxy = unknownModuleProxy();
    const result = new (proxy as any).SomeClass();
    expect(typeof result).toBe("function");
  });

  it("Symbol.toPrimitive returns empty string", () => {
    const proxy = unknownModuleProxy();
    const prim = (proxy as any)[Symbol.toPrimitive];
    expect(prim()).toBe("");
  });

  it("default export returns the proxy", () => {
    const proxy = unknownModuleProxy();
    expect((proxy as any).default).toBe(proxy);
  });

  it("has() returns true for any property", () => {
    const proxy = unknownModuleProxy();
    expect("anything" in proxy).toBe(true);
  });
});

describe("MODULES", () => {
  it("has @rotorsoft/act module with all builders", () => {
    const act = MODULES["@rotorsoft/act"];
    expect(act.state).toBe(mockState);
    expect(act.slice).toBe(mockSlice);
    expect(act.projection).toBe(mockProjection);
    expect(act.act).toBe(mockAct);
    expect(typeof act.store).toBe("function");
    expect(typeof act.dispose).toBe("function");
  });

  it("store() returns mock store with working async methods", async () => {
    const store = (MODULES["@rotorsoft/act"].store as any)();
    await expect(store.seed()).resolves.toBeUndefined();
    await expect(store.drop()).resolves.toBeUndefined();
    await expect(store.commit()).resolves.toEqual([]);
    await expect(store.query()).resolves.toBe(0);
    await expect(store.dispose()).resolves.toBeUndefined();
  });

  it("dispose() returns a function", () => {
    const dispose = (MODULES["@rotorsoft/act"].dispose as any)();
    expect(typeof dispose).toBe("function");
  });

  it("has zod module", () => {
    expect(MODULES.zod.z).toBeDefined();
  });

  it("has crypto modules", () => {
    expect((MODULES.crypto as any).randomUUID()).toBe("mock-uuid");
    expect((MODULES["node:crypto"] as any).randomUUID()).toBe("mock-uuid");
  });

  it("InvariantError is an Error subclass", () => {
    const Err = MODULES["@rotorsoft/act"].InvariantError as any;
    const e = new Err("test");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InvariantError");
    expect(e.message).toBe("test");
  });
});
