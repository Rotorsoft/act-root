import {
  act,
  Actor,
  config,
  InvariantError,
  sleep,
  state,
} from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod/v4";
import { Calculator, DIGITS, KEYS } from "./calculator.js";

/**
 * Type for the projection board state: a count for each digit key (0-9)
 */
export type BoardState = Record<(typeof DIGITS)[number], number>;

/**
 * DigitBoard state: tracks the count of each digit key pressed (0-9)
 */
export const DigitBoard = state(
  "DigitBoard",
  z.object(
    Object.fromEntries(DIGITS.map((d) => [d, z.number().int().default(0)]))
  )
)
  .init(() => Object.fromEntries(DIGITS.map((d) => [d, 0])) as BoardState)
  .emits({ DigitCounted: z.object({ digit: z.enum(DIGITS) }) })
  .patch({
    DigitCounted: ({ data }, state) => ({
      ...state,
      [data.digit]: (state as BoardState)[data.digit] + 1,
    }),
  })
  .on("CountDigit", z.object({ digit: z.enum(DIGITS) }))
  .emit(({ digit }) => ["DigitCounted", { digit }])
  .build();

async function main() {
  // to test with postgres
  // store(new PostgresStore({ schema: "act", table: "calculator", leaseMillis: 30_000 }));
  // await store().drop();
  // await store().seed();

  console.log(config());

  const actor: Actor = { id: randomUUID(), name: "Calculator" };

  // Build the app with Calculator and DigitBoard
  const app = act()
    .with(Calculator)
    .with(DigitBoard)
    // React to every digit pressed and update the projection board
    .on("DigitPressed")
    .do(async function CountDigits(event) {
      await app.do(
        "CountDigit",
        { stream: "Board", actor },
        { digit: event.data.digit },
        event
      );
    })
    .to(() => "Board")
    .build();

  // On every drain, print the digit counts as a table
  app.on("drained", async () => {
    const board = await app.load(DigitBoard, "Board");
    const state = board.state as BoardState;
    console.clear();
    console.log("\n=== Digit Board ===");
    // Print as a 3x3 matrix (digits 1-9)
    let matrix = "";
    for (let row = 0; row < 3; row++) {
      let line = "";
      for (let col = 0; col < 3; col++) {
        const digit = (row * 3 + col + 1).toString() as keyof BoardState;
        line += (state[digit] ?? 0).toString().padStart(3, " ") + " ";
      }
      matrix += line + "\n";
    }
    console.log(matrix);
    // Print the calculator state after the digit board
    const calc = await app.load(Calculator, "A");
    console.log("=== Calculator State ===");
    console.table(calc.state);
  });

  // Helper: pick a random key from KEYS
  const randomKey = () => KEYS[Math.floor(Math.random() * KEYS.length)];

  // Helper: when to stop the loop
  async function shouldStop() {
    const board = await app.load(DigitBoard, "Board");
    const state = board.state as BoardState;
    return DIGITS.some((d) => state[d] > 3);
  }

  // Main loop: press random keys until any digit reaches 10
  while (true) {
    const key = randomKey();
    try {
      await app.do("PressKey", { stream: "A", actor }, { key });
    } catch (err) {
      if (err instanceof InvariantError) {
        console.log("[InvariantError]", err.message);
        continue;
      } else {
        err instanceof Error && console.log(err.message);
        continue;
      }
    }
    await sleep(1000); // slow down for demo
    await app.drain();
    if (await shouldStop()) {
      console.log("Stopping demo.\n");
      break;
    }
  }

  // Show final calculator state
  const calc = await app.load(Calculator, "A");
  console.log("\nFinal Calculator State:", calc.state);

  // Print a table of all recorded events for stream 'A'
  const recorded: any[] = [];
  await app.query({ stream: "A" }, (event) => recorded.push(event));
  console.log("\nAll Recorded Events for stream 'A':");
  console.table(
    recorded.map((e) => ({ name: e.name, data: e.data, timestamp: e.created }))
  );
}

void main();
