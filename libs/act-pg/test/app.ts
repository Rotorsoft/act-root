import { act, ReactionHandler, sleep, state, ZodEmpty } from "@rotorsoft/act";
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

export const onIncremented = vi.fn().mockImplementation(async () => {
  await sleep(100);
  console.log("onIncremented OK");
});
export const onDecremented = vi.fn().mockImplementation(async () => {
  await sleep(100);
  throw new Error("onDecremented failed");
});

export const app = act()
  .with(counter)
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

export const actor = { id: "a", name: "a" };
