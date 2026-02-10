/**
 * @module slice-builder
 * @category Builders
 *
 * Fluent builder for vertical feature slices that extend existing states.
 */
import type { ZodType } from "zod";
import type {
  ActionHandler,
  Invariant,
  PatchHandler,
  Reaction,
  ReactionHandler,
  ReactionOptions,
  ReactionResolver,
  Schema,
  Schemas,
  State,
  ZodTypes,
} from "./types/index.js";

// resolves the event stream as source and target (default)
const _this_ = ({ stream }: { stream: string }) => ({
  source: stream,
  target: stream,
});
// resolves to nothing
const _void_ = () => undefined;

/**
 * A state contribution from a slice: the base state reference plus only the NEW
 * events, patches, actions, handlers, and invariants added by the slice.
 */
export type StateContribution = {
  readonly base: State<Schema, Schemas, Schemas>;
  readonly events: Record<string, ZodType>;
  readonly patch: Record<string, PatchHandler<Schema, Schemas, string>>;
  readonly actions: Record<string, ZodType>;
  readonly on: Record<string, ActionHandler<Schema, Schemas, Schemas, string>>;
  readonly given: Record<string, Invariant<Schema>[]>;
};

/**
 * A reaction declared by a slice.
 */
export type SliceReaction = {
  readonly event: string;
  readonly reaction: Reaction<Schemas, string>;
};

/**
 * A vertical feature slice: a self-contained unit of functionality that can
 * extend existing states with new events, patches, actions, invariants, and reactions.
 *
 * @example
 * ```typescript
 * const escalation = slice("escalation")
 *   .with(Ticket)
 *     .events({ TicketEscalated: z.object({ reason: z.string() }) })
 *     .patches({ TicketEscalated: (e, s) => ({ status: "escalated" }) })
 *     .action("EscalateTicket", schema)
 *       .emit((data) => ["TicketEscalated", data])
 *   .on("TicketEscalated")
 *     .do(async ({ event, app }) => { ... })
 *     .void()
 *   .build();
 * ```
 */
export type Slice = {
  readonly kind: "slice";
  readonly name: string;
  readonly states: ReadonlyMap<string, StateContribution>;
  readonly reactions: ReadonlyArray<SliceReaction>;
  diagram(): string;
};

/**
 * Type guard for Slice objects.
 */
export function isSlice(value: unknown): value is Slice {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Slice).kind === "slice"
  );
}

/**
 * Builder for composing a vertical feature slice.
 */
export type SliceBuilder = {
  with: <SX extends Schema, EX extends Schemas, AX extends Schemas>(
    state: State<SX, EX, AX>
  ) => SliceStateBuilder<SX, EX, AX>;
  on: (event: string) => {
    do: (
      handler: ReactionHandler<Schemas, string>,
      options?: Partial<ReactionOptions>
    ) => SliceBuilder & {
      to: (
        resolver: ReactionResolver<Schemas, string> | string
      ) => SliceBuilder;
      void: () => SliceBuilder;
    };
  };
  build: () => Slice;
};

/**
 * Builder for extending a specific state within a slice.
 */
export type SliceStateBuilder<
  S extends Schema,
  E extends Schemas,
  A extends Schemas,
> = SliceBuilder & {
  events: <EX extends Schemas>(
    events: ZodTypes<EX>
  ) => {
    patches: (patches: {
      [K in keyof EX]: PatchHandler<S, EX, K & string>;
    }) => SliceStateBuilder<S, E & EX, A>;
  };
  action: <K extends string, AX extends Schema>(
    name: K,
    schema: ZodType<AX>
  ) => {
    given: (rules: Invariant<S>[]) => {
      emit: (
        handler: ActionHandler<S, E, { [P in K]: AX }, K>
      ) => SliceStateBuilder<S, E, A & { [P in K]: AX }>;
    };
    emit: (
      handler: ActionHandler<S, E, { [P in K]: AX }, K>
    ) => SliceStateBuilder<S, E, A & { [P in K]: AX }>;
  };
};

/**
 * Creates a new slice builder for defining a vertical feature slice.
 *
 * Slices are self-contained units of functionality that extend existing states
 * with new events, patches, actions, invariants, and reactions. They enable
 * parallel development by allowing multiple developers to work on separate
 * feature slices without editing shared files.
 *
 * @param name - Unique name for the slice
 * @returns A SliceBuilder for fluent configuration
 *
 * @example Extending a state with new events and actions
 * ```typescript
 * const escalation = slice("escalation")
 *   .with(Ticket)
 *     .events({ TicketEscalated: z.object({ reason: z.string() }) })
 *     .patches({ TicketEscalated: (e, s) => ({ status: "escalated" }) })
 *     .action("EscalateTicket", z.object({ reason: z.string() }))
 *       .emit((data) => ["TicketEscalated", { reason: data.reason }])
 *   .build();
 * ```
 *
 * @example Reactions-only slice
 * ```typescript
 * const autoAssign = slice("auto-assign")
 *   .on("TicketOpened")
 *     .do(async ({ event, app }) => {
 *       await app.do("AssignTicket", { stream: event.stream, ... }, agent, event);
 *     })
 *     .void()
 *   .build();
 * ```
 *
 * @example Composing slices
 * ```typescript
 * const app = act()
 *   .with(Ticket)
 *   .with(escalation)
 *   .with(autoAssign)
 *   .build();
 * ```
 */
export function slice(name: string): SliceBuilder {
  const contributions = new Map<string, StateContribution>();
  const reactions: SliceReaction[] = [];

  function makeSliceBuilder(): SliceBuilder {
    return {
      with<SX extends Schema, EX extends Schemas, AX extends Schemas>(
        state: State<SX, EX, AX>
      ) {
        return makeSliceStateBuilder<SX, EX, AX>(state);
      },

      on(event: string) {
        return {
          do(
            handler: ReactionHandler<Schemas, string>,
            options?: Partial<ReactionOptions>
          ) {
            const entry: SliceReaction = {
              event,
              reaction: {
                handler,
                resolver: _this_,
                options: {
                  blockOnError: options?.blockOnError ?? true,
                  maxRetries: options?.maxRetries ?? 3,
                },
              },
            };
            reactions.push(entry);
            const idx = reactions.length - 1;
            const builder = makeSliceBuilder();
            return {
              ...builder,
              to(resolver: ReactionResolver<Schemas, string> | string) {
                reactions[idx] = {
                  ...entry,
                  reaction: {
                    ...entry.reaction,
                    resolver:
                      typeof resolver === "string"
                        ? { target: resolver }
                        : resolver,
                  },
                };
                return builder;
              },
              void() {
                reactions[idx] = {
                  ...entry,
                  reaction: {
                    ...entry.reaction,
                    resolver: _void_,
                  },
                };
                return builder;
              },
            };
          },
        };
      },

      build(): Slice {
        return {
          kind: "slice" as const,
          name,
          states: contributions,
          reactions,
          diagram() {
            return generateDiagram(name, contributions, reactions);
          },
        };
      },
    };
  }

  function makeSliceStateBuilder<
    S extends Schema,
    E extends Schemas,
    A extends Schemas,
  >(baseState: State<S, E, A>): SliceStateBuilder<S, E, A> {
    // Get or create contribution for this state
    if (!contributions.has(baseState.name)) {
      contributions.set(baseState.name, {
        base: baseState as unknown as State<Schema, Schemas, Schemas>,
        events: {},
        patch: {},
        actions: {},
        on: {},
        given: {},
      });
    }
    const contrib = contributions.get(baseState.name)!;

    const parent = makeSliceBuilder();

    const stateBuilder: SliceStateBuilder<S, E, A> = {
      // Forward slice-level methods
      with: parent.with,
      on: parent.on,
      build: parent.build,

      events<EX extends Schemas>(events: ZodTypes<EX>) {
        Object.assign(contrib.events, events);
        return {
          patches(patches: {
            [K in keyof EX]: PatchHandler<S, EX, K & string>;
          }) {
            Object.assign(contrib.patch, patches);
            return makeSliceStateBuilder<S, E & EX, A>(
              baseState as unknown as State<S, E & EX, A>
            );
          },
        };
      },

      action<K extends string, AX extends Schema>(
        actionName: K,
        schema: ZodType<AX>
      ) {
        contrib.actions[actionName] = schema;

        function given(rules: Invariant<S>[]) {
          contrib.given[actionName] = rules as Invariant<Schema>[];
          return { emit };
        }

        function emit(handler: ActionHandler<S, E, { [P in K]: AX }, K>) {
          contrib.on[actionName] = handler as unknown as ActionHandler<
            Schema,
            Schemas,
            Schemas,
            string
          >;
          return makeSliceStateBuilder<S, E, A & { [P in K]: AX }>(
            baseState as unknown as State<S, E, A & { [P in K]: AX }>
          );
        }

        return { given, emit };
      },
    };

    return stateBuilder;
  }

  return makeSliceBuilder();
}

/**
 * Generates a mermaid diagram for a slice.
 */
function generateDiagram(
  name: string,
  states: ReadonlyMap<string, StateContribution>,
  reactions: ReadonlyArray<SliceReaction>
): string {
  const lines: string[] = ["graph LR"];
  lines.push(`  subgraph ${name}["slice: ${name}"]`);

  for (const [stateName, contrib] of states) {
    const actions = Object.keys(contrib.actions);
    const events = Object.keys(contrib.events);
    if (actions.length || events.length) {
      lines.push(`    subgraph ${stateName}["${stateName}"]`);
      for (const a of actions) {
        lines.push(`      A_${a}["${a}"]`);
      }
      for (const e of events) {
        lines.push(`      E_${e}(["${e}"])`);
      }
      // Connect actions to events they might emit
      for (const a of actions) {
        for (const e of events) {
          lines.push(`      A_${a} --> E_${e}`);
        }
      }
      lines.push(`    end`);
    }
  }

  for (const { event, reaction } of reactions) {
    const resolver = reaction.resolver;
    const isVoid = typeof resolver === "function" && resolver.name === "_void_";
    const target =
      typeof resolver === "function"
        ? isVoid
          ? "void"
          : "handler"
        : resolver?.target || "void";
    lines.push(
      `    E_${event} -.->|${target}| ${isVoid ? "void_" + event : target}`
    );
  }

  lines.push(`  end`);
  return lines.join("\n");
}
