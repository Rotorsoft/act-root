import { randomUUID } from "node:crypto";
import { type Actor, act, state } from "@rotorsoft/act";
import { z } from "zod";
import { Calculator, DIGITS } from "./calculator.js";

/**
 * Type for the projection board state: a count for each digit key (0-9)
 */
export type BoardState = Record<(typeof DIGITS)[number], number>;

/**
 * DigitBoard state: tracks the count of each digit key pressed (0-9)
 */
export const DigitBoard = state({
  DigitBoard: z.object(
    Object.fromEntries(DIGITS.map((d) => [d, z.number().int().default(0)]))
  ),
})
  .init(() => Object.fromEntries(DIGITS.map((d) => [d, 0])) as BoardState)
  .emits({ DigitCounted: z.object({ digit: z.enum(DIGITS) }) })
  .patch({
    DigitCounted: ({ data }, state) => ({
      ...state,
      [data.digit]: (state as BoardState)[data.digit] + 1,
    }),
  })
  .on({ CountDigit: z.object({ digit: z.enum(DIGITS) }) })
  .emit("DigitCounted")
  .build();

/**
 * Calculator projection: tracks the result of each calculator
 */
export const CalculatorResult = state({
  CalculatorResult: z.object({
    result: z.number(),
  }),
})
  .init(() => ({ result: 0 }))
  .emits({ ResultProjected: z.object({ result: z.number() }) })
  .on({ ProjectResult: z.object({ result: z.number() }) })
  .emit("ResultProjected")
  .build();

export const actor: Actor = { id: randomUUID(), name: "Calculator" };
const streams = ["A", "B"];

// Build the app with Calculator and DigitBoard
export const app = act()
  .withState(Calculator)
  .withState(DigitBoard)
  .withState(CalculatorResult)
  // React to every digit pressed and update the projection board
  .on("DigitPressed")
  .do(async function CountDigits(event) {
    await app.do(
      "CountDigit",
      { stream: "Board", actor },
      { digit: event.data.digit },
      { reactingTo: event }
    );
  })
  .to({ source: `^(${streams.join("|")})$`, target: "Board" })
  .on("OperatorPressed")
  .do(async function ProjectResult(event) {
    // Load the current calculator state
    const stream = event.stream;
    const calc = await app.load(Calculator, stream);
    // Project the result of the calculator
    await app.do(
      "ProjectResult",
      { stream: "Calculator" + stream, actor },
      { result: calc.state.result },
      { reactingTo: event }
    );
  })
  .to((e) => ({
    source: e.stream,
    target: "Calculator" + e.stream,
  }))
  .build({ autoSettle: false });
