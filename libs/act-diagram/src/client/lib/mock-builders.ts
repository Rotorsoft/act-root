/**
 * Mock Act framework builders that capture domain model structure
 * (state names, events, actions, reactions, invariants) without
 * needing the real framework runtime.
 */
import { z } from "zod";
import type { ReactionNode } from "../types/index.js";

/** Shared no-op function used as Proxy targets (body is never reached through the proxy) */
export function proxy_target() {}

function attach_emit(
  info: { actions: Record<string, any>; events: Record<string, any> },
  action_name: string,
  handler: any
) {
  const emits: string[] = [];
  if (typeof handler === "string") {
    emits.push(handler);
  } else if (typeof handler === "function") {
    // Strategy 1: string search for event names in handler source
    const src = String(handler);
    for (const event_name of Object.keys(info.events)) {
      if (
        src.includes(`"${event_name}"`) ||
        src.includes(`'${event_name}'`) ||
        src.includes(`\`${event_name}\``)
      ) {
        emits.push(event_name);
      }
    }

    // Strategy 2: if string search found nothing, try safe-executing
    // the handler with Proxy-based dummy args to capture event name
    if (emits.length === 0) {
      try {
        const deep_proxy: any = new Proxy(
          {},
          {
            get: () => deep_proxy,
            has: () => true,
          }
        );
        const proxy_fn = new Proxy(proxy_target, {
          get: () => deep_proxy,
          apply: () => deep_proxy,
        });
        const dummy_arg = new Proxy(
          {},
          {
            get: (_t, prop) => {
              if (typeof prop === "string") return proxy_fn;
              return undefined;
            },
          }
        );
        const result = handler(dummy_arg, dummy_arg, dummy_arg);
        if (Array.isArray(result) && typeof result[0] === "string") {
          emits.push(result[0]);
        }
      } catch {
        // Proxy execution failed — keep emits empty
      }
    }
  }
  (info.actions as any)[`__emits_${action_name}`] = emits;
}

export function mock_state(
  entry: Record<string, any>,
  on_build?: (info: any) => void
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

  const action_builder = (_currentAction?: string): any => ({
    on(action_entry: Record<string, any>) {
      const action_name = Object.keys(action_entry)[0];
      info.actions[action_name] = action_entry[action_name];
      return {
        given(rules?: any[]) {
          if (rules) info.given[action_name] = rules;
          return {
            emit(handler: any) {
              attach_emit(info, action_name, handler);
              return action_builder(action_name);
            },
          };
        },
        emit(handler: any) {
          attach_emit(info, action_name, handler);
          return action_builder(action_name);
        },
      };
    },
    snap: () => action_builder(_currentAction),
    build: () => {
      on_build?.(info);
      return info;
    },
  });

  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    init: (_initFn?: any) => ({
      emits(events: Record<string, any>) {
        info.events = events ?? {};
        return {
          ...action_builder(),
          patch(patches?: Record<string, any>) {
            if (patches)
              for (const k of Object.keys(patches)) info.patches.add(k);
            return action_builder();
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
function capture_dispatches(handler: any): string[] {
  const dispatches: string[] = [];
  if (typeof handler !== "function") return dispatches;

  // Strategy 1: execute handler with mock app to capture app.do() calls
  try {
    const safe_proxy = (): any =>
      new Proxy({} as Record<string, unknown>, { get: () => "" });
    const mock_app = {
      do: (action_name: string) => {
        if (
          typeof action_name === "string" &&
          !dispatches.includes(action_name)
        )
          dispatches.push(action_name);
        return Promise.resolve([]);
      },
      load: () => Promise.resolve({ state: safe_proxy(), version: 0 }),
      query: () => Promise.resolve({ count: 0 }),
      query_array: () => Promise.resolve([]),
    };
    const mock_event = new Proxy({} as Record<string, unknown>, {
      get: (_, prop) =>
        prop === "stream"
          ? "mock"
          : prop === "data"
            ? new Proxy({}, { get: () => "" })
            : "",
    });
    const result = handler(mock_event, "mock", mock_app);
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

export function mock_slice(on_build?: (info: any) => void) {
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
    on(event_name: string) {
      return {
        do(handler: any) {
          const dispatches = capture_dispatches(handler);
          const reaction: ReactionNode = {
            event: event_name,
            handlerName:
              (typeof handler?.name === "string" && handler.name) ||
              `on ${event_name}`,
            dispatches,
          };
          info.reactions.push(reaction);
          return {
            ...builder,
            to() {
              return builder;
            },
          };
        },
      };
    },
    build: () => {
      on_build?.(info);
      return info;
    },
  };
  return builder;
}

export function mock_projection(
  target?: string,
  on_build?: (info: any) => void
) {
  const info = {
    _tag: "Projection" as const,
    target: target || "projection",
    handles: [] as string[],
  };

  const builder: any = {
    on(event_entry: Record<string, any>) {
      const event_name = Object.keys(event_entry)[0];
      info.handles.push(event_name);
      return {
        do() {
          return {
            ...builder,
            to(resolver: any) {
              if (typeof resolver === "string") info.target = resolver;
              return builder;
            },
          };
        },
      };
    },
    build: () => {
      on_build?.(info);
      return info;
    },
  };
  return builder;
}

export function mock_act(on_build?: (info: any) => void) {
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
    on(event_name: string) {
      return {
        do(handler: any) {
          const dispatches = capture_dispatches(handler);
          const reaction: ReactionNode = {
            event: event_name,
            handlerName:
              (typeof handler?.name === "string" && handler.name) ||
              `on ${event_name}`,
            dispatches,
          };
          info.reactions.push(reaction);
          return {
            ...builder,
            to() {
              return builder;
            },
          };
        },
      };
    },
    build: () => {
      const noop = () => act_stub;
      const act_stub: any = {
        ...info,
        on: () => act_stub,
        do: () => Promise.resolve([]),
        load: () => Promise.resolve({}),
        drain: () => Promise.resolve(),
        correlate: () => Promise.resolve({ subscribed: 0, last_id: 0 }),
        settle: noop,
        start_correlations: noop,
        query_array: () => Promise.resolve([]),
      };
      on_build?.(act_stub);
      return act_stub;
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

const crypto_mock = { randomUUID: () => "mock-uuid" };

/** Module map for the evaluator's require() */
export const MODULES: Record<string, Record<string, unknown>> = {
  "@rotorsoft/act": {
    state: mock_state,
    slice: mock_slice,
    projection: mock_projection,
    act: mock_act,
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
  crypto: crypto_mock,
  "node:crypto": crypto_mock,
};

/**
 * Returns a deep Proxy for unknown modules — any property access
 * returns a no-op function that also acts as a Proxy.
 */
export function unknown_module_proxy(): Record<string, unknown> {
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
  const proxy: any = new Proxy(proxy_target, handler);
  return proxy;
}
