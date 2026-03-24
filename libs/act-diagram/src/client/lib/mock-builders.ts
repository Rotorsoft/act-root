/**
 * Mock Act framework builders that capture domain model structure
 * (state names, events, actions, reactions, invariants) without
 * needing the real framework runtime.
 */
import { z } from "zod";
import type { ReactionNode } from "../types/index.js";

/** Shared no-op function used as Proxy targets (body is never reached through the proxy) */
export function proxyTarget() {}

function attachEmit(
  info: { actions: Record<string, any>; events: Record<string, any> },
  actionName: string,
  handler: any
) {
  const emits: string[] = [];
  if (typeof handler === "string") {
    emits.push(handler);
  } else if (typeof handler === "function") {
    // Strategy 1: string search for event names in handler source
    const src = String(handler);
    for (const eventName of Object.keys(info.events)) {
      if (
        src.includes(`"${eventName}"`) ||
        src.includes(`'${eventName}'`) ||
        src.includes(`\`${eventName}\``)
      ) {
        emits.push(eventName);
      }
    }

    // Strategy 2: if string search found nothing, try safe-executing
    // the handler with Proxy-based dummy args to capture event name
    if (emits.length === 0) {
      try {
        const deepProxy: any = new Proxy(
          {},
          {
            get: () => deepProxy,
            has: () => true,
          }
        );
        const proxyFn = new Proxy(proxyTarget, {
          get: () => deepProxy,
          apply: () => deepProxy,
        });
        const dummyArg = new Proxy(
          {},
          {
            get: (_t, prop) => {
              if (typeof prop === "string") return proxyFn;
              return undefined;
            },
          }
        );
        const result = handler(dummyArg, dummyArg, dummyArg);
        if (Array.isArray(result) && typeof result[0] === "string") {
          emits.push(result[0]);
        }
      } catch {
        // Proxy execution failed — keep emits empty
      }
    }
  }
  (info.actions as any)[`__emits_${actionName}`] = emits;
}

export function mockState(
  entry: Record<string, any>,
  onBuild?: (info: any) => void
) {
  const name = Object.keys(entry)[0];
  const info = {
    name,
    events: {} as Record<string, any>,
    actions: {} as Record<string, any>,
    given: {} as Record<string, any[]>,
    patches: new Set<string>(),
    _tag: "State" as const,
  };

  const actionBuilder = (_currentAction?: string): any => ({
    on(actionEntry: Record<string, any>) {
      const actionName = Object.keys(actionEntry)[0];
      info.actions[actionName] = actionEntry[actionName];
      return {
        given(rules?: any[]) {
          if (rules) info.given[actionName] = rules;
          return {
            emit(handler: any) {
              attachEmit(info, actionName, handler);
              return actionBuilder(actionName);
            },
          };
        },
        emit(handler: any) {
          attachEmit(info, actionName, handler);
          return actionBuilder(actionName);
        },
      };
    },
    snap: () => actionBuilder(_currentAction),
    build: () => {
      onBuild?.(info);
      return info;
    },
  });

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    init: (_initFn?: any) => ({
      emits(events: Record<string, any>) {
        info.events = events ?? {};
        return {
          ...actionBuilder(),
          patch(patches?: Record<string, any>) {
            if (patches)
              for (const k of Object.keys(patches)) info.patches.add(k);
            return actionBuilder();
          },
        };
      },
    }),
  };
}

/**
 * Extract dispatched action names from a reaction handler.
 * First tries runtime execution with a mock app; if the handler has
 * conditional branches that prevent reaching app.do(), falls back to
 * parsing the handler source for `.do("ActionName")` calls.
 */
function captureDispatches(handler: any): string[] {
  const dispatches: string[] = [];
  if (typeof handler !== "function") return dispatches;

  // Strategy 1: execute handler with mock app to capture app.do() calls
  try {
    const mockApp = {
      do: (actionName: string) => {
        if (typeof actionName === "string" && !dispatches.includes(actionName))
          dispatches.push(actionName);
        return Promise.resolve([]);
      },
      load: () => Promise.resolve({}),
      query: () => Promise.resolve({ count: 0 }),
      query_array: () => Promise.resolve([]),
    };
    const mockEvent = new Proxy({} as Record<string, unknown>, {
      get: (_, prop) =>
        prop === "stream"
          ? "mock"
          : prop === "data"
            ? new Proxy({}, { get: () => "" })
            : "",
    });
    const result = handler(mockEvent, "mock", mockApp);
    // Swallow async rejections (handlers that access db, etc.)
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // handler threw — dispatches stays as captured so far
  }

  // Strategy 2: if runtime missed dispatches (e.g. conditional branches),
  // parse the handler source for .do("ActionName") calls as fallback
  if (dispatches.length === 0) {
    const src = String(handler);
    const re = /\.do\(\s*["'](\w+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (!dispatches.includes(m[1])) dispatches.push(m[1]);
    }
  }

  return dispatches;
}

export function mockSlice(onBuild?: (info: any) => void) {
  const info = {
    _tag: "Slice" as const,
    states: [] as any[],
    projections: [] as any[],
    reactions: [] as ReactionNode[],
  };

  const builder: any = {
    withState(s: any) {
      info.states.push(s ?? null);
      return builder;
    },
    withProjection(p: any) {
      if (p) info.projections.push(p);
      return builder;
    },
    on(eventName: string) {
      return {
        do(handler: any) {
          const dispatches = captureDispatches(handler);
          const reaction: ReactionNode = {
            event: eventName,
            handlerName:
              (typeof handler?.name === "string" && handler.name) ||
              `on ${eventName}`,
            dispatches,
            isVoid: false,
          };
          info.reactions.push(reaction);
          return {
            ...builder,
            to() {
              reaction.isVoid = false;
              return builder;
            },
            void() {
              reaction.isVoid = true;
              return builder;
            },
          };
        },
      };
    },
    build: () => {
      onBuild?.(info);
      return info;
    },
  };
  return builder;
}

export function mockProjection(target?: string, onBuild?: (info: any) => void) {
  const info = {
    _tag: "Projection" as const,
    target: target || "projection",
    handles: [] as string[],
  };

  const builder: any = {
    on(eventEntry: Record<string, any>) {
      const eventName = Object.keys(eventEntry)[0];
      info.handles.push(eventName);
      return {
        do() {
          return {
            ...builder,
            to(resolver: any) {
              if (typeof resolver === "string") info.target = resolver;
              return builder;
            },
            void: () => builder,
          };
        },
      };
    },
    build: () => {
      onBuild?.(info);
      return info;
    },
  };
  return builder;
}

export function mockAct(onBuild?: (info: any) => void) {
  const info = {
    _tag: "Act" as const,
    states: [] as any[],
    slices: [] as any[],
    projections: [] as any[],
    reactions: [] as ReactionNode[],
  };

  const builder: any = {
    withState(s: any) {
      info.states.push(s ?? null);
      return builder;
    },
    withSlice(s: any) {
      // Always push (even null/undefined) to preserve positional alignment
      // with slice variable names extracted from .withSlice(VAR) in source
      info.slices.push(s ?? null);
      return builder;
    },
    withProjection(p: any) {
      if (p) info.projections.push(p);
      return builder;
    },
    withActor: () => builder,
    on(eventName: string) {
      return {
        do(handler: any) {
          const dispatches = captureDispatches(handler);
          const reaction: ReactionNode = {
            event: eventName,
            handlerName:
              (typeof handler?.name === "string" && handler.name) ||
              `on ${eventName}`,
            dispatches,
            isVoid: false,
          };
          info.reactions.push(reaction);
          return {
            ...builder,
            to() {
              reaction.isVoid = false;
              return builder;
            },
            void() {
              reaction.isVoid = true;
              return builder;
            },
          };
        },
      };
    },
    build: () => {
      const noop = () => actStub;
      const actStub: any = {
        ...info,
        on: () => actStub,
        do: () => Promise.resolve([]),
        load: () => Promise.resolve({}),
        drain: () => Promise.resolve(),
        correlate: () => Promise.resolve({ subscribed: 0, last_id: 0 }),
        settle: noop,
        start_correlations: noop,
        query_array: () => Promise.resolve([]),
      };
      onBuild?.(actStub);
      return actStub;
    },
  };
  return builder;
}

class InvariantError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "InvariantError";
  }
}

const cryptoMock = { randomUUID: () => "mock-uuid" };

/** Module map for the evaluator's require() */
export const MODULES: Record<string, Record<string, unknown>> = {
  "@rotorsoft/act": {
    state: mockState,
    slice: mockSlice,
    projection: mockProjection,
    act: mockAct,
    store: () => ({
      seed: () => Promise.resolve(),
      drop: () => Promise.resolve(),
      commit: () => Promise.resolve([]),
      query: () => Promise.resolve(0),
      dispose: () => Promise.resolve(),
    }),
    dispose: () => () => Promise.resolve(),
    ZodEmpty: z.record(z.string(), z.never()),
    InvariantError,
  },
  zod: { z, ...z },
  crypto: cryptoMock,
  "node:crypto": cryptoMock,
};

/**
 * Returns a deep Proxy for unknown modules — any property access
 * returns a no-op function that also acts as a Proxy.
 */
export function unknownModuleProxy(): Record<string, unknown> {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "default") return proxy;
      return proxy;
    },
    apply() {
      return proxy;
    },
    construct() {
      return proxy;
    },
    has() {
      return true;
    },
  };
  const proxy: any = new Proxy(proxyTarget, handler);
  return proxy;
}
