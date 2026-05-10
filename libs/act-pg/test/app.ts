import {
  act,
  type ReactionHandler,
  sleep,
  state,
  ZodEmpty,
} from "@rotorsoft/act";
import z from "zod";

const counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ incremented: ZodEmpty, decremented: ZodEmpty })
  .patch({
    incremented: (_, state) => ({ count: state.count + 1 }),
    decremented: (_, state) => ({ count: state.count - 1 }),
  })
  .on({ increment: ZodEmpty })
  .emit(() => ["incremented", {}])
  .on({ decrement: ZodEmpty })
  .emit(() => ["decremented", {}])
  .build();

// Explicit type annotation needed because tsc declaration emit otherwise
// references the private `@vitest/spy` path; declaring the surface as the
// orchestrator's `ReactionHandler` keeps the .d.ts portable.
type AnyReaction = ReactionHandler<
  {
    incremented: Record<string, never>;
    decremented: Record<string, never>;
  },
  "incremented" | "decremented"
>;

export const onIncremented: AnyReaction = vi
  .fn()
  .mockImplementation(async () => {
    await sleep(100);
  });
export const onDecremented: AnyReaction = vi
  .fn()
  .mockImplementation(async () => {
    await sleep(100);
    throw new Error("onDecremented failed");
  });

/**
 * Build the test app on demand — `act()...build()` wires the orchestrator
 * against whichever store is current, so tests must call this *after*
 * injecting their `PostgresStore` via `store(adapter)`.
 */
export function buildApp() {
  return act()
    .withState(counter)
    .on("incremented")
    .do(
      onIncremented as ReactionHandler<
        {
          incremented: Record<string, never>;
          decremented: Record<string, never>;
        },
        "incremented"
      >
    )
    .on("decremented")
    .do(
      onDecremented as ReactionHandler<
        {
          incremented: Record<string, never>;
          decremented: Record<string, never>;
        },
        "decremented"
      >,
      {
        maxRetries: 2,
        blockOnError: true,
      }
    )
    .build();
}

/**
 * Late-bound alias populated by the test's `beforeAll`. Exported so
 * spec files can keep their existing `app.do(...)` ergonomics — but the
 * binding is filled only after the store has been injected.
 */
export let app: ReturnType<typeof buildApp>;

export function setApp(instance: ReturnType<typeof buildApp>) {
  app = instance;
}

export const actor = { id: "a", name: "a" };
