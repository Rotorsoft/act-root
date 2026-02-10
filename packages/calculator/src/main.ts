import {
  act,
  Actor,
  config,
  InvariantError,
  sleep,
  state,
} from "@rotorsoft/act";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Calculator, DIGITS, KEYS } from "./calculator.js";

/**
 * Type for the projection board state: a count for each digit key (0-9)
 */
export type BoardState = Record<(typeof DIGITS)[number], number>;

/**
 * DigitBoard state: tracks the count of each digit key pressed (0-9)
 */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
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
/* eslint-enable @typescript-eslint/no-unsafe-argument */

/**
 * Calculator projection: tracks the result of each calculator
 */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
const CalculatorResult = state(
  "CalculatorResult",
  z.object({
    result: z.number(),
  })
)
  .init(() => ({ result: 0 }))
  .emits({ ResultProjected: z.object({ result: z.number() }) })
  .patch({ ResultProjected: ({ data }) => data })
  .on("ProjectResult", z.object({ result: z.number() }))
  .emit(({ result }) => ["ResultProjected", { result }])
  .build();
/* eslint-enable @typescript-eslint/no-unsafe-argument */

async function main() {
  // to test with postgres
  // store(new PostgresStore({ schema: "act", table: "calculator", leaseMillis: 30_000 }));
  // await store().drop();
  // await store().seed();

  console.log(config());

  const actor: Actor = { id: randomUUID(), name: "Calculator" };
  const streams = ["A", "B"];

  // Build the app with Calculator and DigitBoard
  const app = act()
    .with(Calculator)
    .with(DigitBoard)
    .with(CalculatorResult)
    // React to every digit pressed and update the projection board
    .on("DigitPressed")
    .do(async function CountDigits({ event, app: a }) {
      await a.do(
        "CountDigit",
        { stream: "Board", actor },
        { digit: event.data.digit },
        event
      );
    })
    .to({ source: `^(${streams.join("|")})$`, target: "Board" })
    .on("OperatorPressed")
    .do(async function ProjectResult({ event, app: a }) {
      // Load the current calculator state
      const calc = await a.load(Calculator, event.stream);
      // Project the result of the calculator
      await a.do(
        "ProjectResult",
        { stream: "Calculator" + event.stream, actor },
        { result: calc.state.result },
        event
      );
    })
    .to((e) => ({
      source: e.stream,
      target: "Calculator" + e.stream,
    }))
    .build();

  // start the correlation pump
  app.start_correlations();

  // Helper: print the calculator state after the digit board
  const printStreamStates = async () => {
    for (const stream of streams) {
      const calc = await app.load(Calculator, stream);
      console.log(`=== ${stream} State ===`);
      console.table(calc.state);
    }
  };

  // On every drain, print the digit counts as a table
  app.on("acked", async () => {
    const board = await app.load(DigitBoard, "Board");
    const state = board.state as BoardState;
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

    await printStreamStates();
  });

  // On every commit of result projection, print the result
  app.on("committed", async ([snapshot]) => {
    const stream = snapshot.event?.stream || "";
    if (stream.startsWith("Calculator")) {
      const result = await app.load(CalculatorResult, stream);
      console.log(`=== Result for ${stream} ===`);
      console.log(result.state.result);
    }
  });

  // Helper: pick a random key from KEYS
  const randomKey = () => KEYS[Math.floor(Math.random() * KEYS.length)];

  // Helper: pick a random stream
  const randomStream = () =>
    streams[Math.floor(Math.random() * streams.length)];

  // Helper: when to stop the loop
  async function shouldStop() {
    const board = await app.load(DigitBoard, "Board");
    const state = board.state as BoardState;
    return DIGITS.some((d) => state[d] > 3);
  }

  // Main loop: press random keys until any digit reaches 10
  while (true) {
    const key = randomKey();
    const stream = randomStream();
    try {
      await app.do("PressKey", { stream, actor }, { key });
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
    await app.drain({
      streamLimit: 5,
      eventLimit: 25,
    });
    if (await shouldStop()) {
      console.log("Stopping demo.\n");
      break;
    }
  }

  // Show final calculator state
  await printStreamStates();

  // Print a table of all recorded events for all streams
  const allEvents: any[] = [];
  await app.query({ with_snaps: true }, (event) => allEvents.push(event));
  console.log("\nAll Recorded Events");
  console.table(
    allEvents.map((e) => ({
      id: e.id,
      stream: e.stream,
      name: e.name,
      data: e.data,
      timestamp: e.created,
    }))
  );
}

void main();
