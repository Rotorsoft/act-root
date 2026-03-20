/**
 * Mock Act framework builders that capture domain model structure
 * (state names, events, actions, reactions, invariants) without
 * needing the real framework runtime.
 */
import { z } from "zod";
import type { ReactionNode } from "../types/index.js";

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
            apply: () => deepProxy,
            has: () => true,
          }
        );
        const proxyFn = new Proxy(function () {}, {
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

export function mockState(entry: Record<string, any>) {
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
    build: () => info,
  });

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    init: (_initFn?: any) => ({
      emits(events: Record<string, any>) {
        info.events = events || {};
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

export function mockSlice() {
  const info = {
    _tag: "Slice" as const,
    states: [] as any[],
    projections: [] as any[],
    reactions: [] as ReactionNode[],
  };

  const builder: any = {
    withState(s: any) {
      info.states.push(s);
      return builder;
    },
    withProjection(p: any) {
      info.projections.push(p);
      return builder;
    },
    on(eventName: string) {
      return {
        do(handler: any) {
          const reaction: ReactionNode = {
            event: eventName,
            handlerName: (handler?.name as string) || `on ${eventName}`,
            dispatches: [],
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
    build: () => info,
  };
  return builder;
}

export function mockProjection(target?: string) {
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
    build: () => info,
  };
  return builder;
}

export function mockAct() {
  const info = {
    _tag: "Act" as const,
    states: [] as any[],
    slices: [] as any[],
    projections: [] as any[],
    reactions: [] as ReactionNode[],
  };

  const builder: any = {
    withState(s: any) {
      info.states.push(s);
      return builder;
    },
    withSlice(s: any) {
      info.slices.push(s);
      return builder;
    },
    withProjection(p: any) {
      info.projections.push(p);
      return builder;
    },
    withActor: () => builder,
    on(eventName: string) {
      return {
        do(handler: any) {
          const reaction: ReactionNode = {
            event: eventName,
            handlerName: (handler?.name as string) || `on ${eventName}`,
            dispatches: [],
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
    store: () => ({}),
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
  const proxy: any = new Proxy(function () {}, handler);
  return proxy;
}
