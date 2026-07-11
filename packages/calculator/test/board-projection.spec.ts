import { type Actor, act, dispose, state } from "@rotorsoft/act";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Calculator, DIGITS } from "../src/index.js";

// ACT-1220: the calculator's shipped board reaction sources from a static
// regex — `source: "^(A|B)$"` — so a single projection stream ("Board")
// consumes DigitPressed from every per-calculator stream. #1215's
// exact-only claim contract meant `_max_event_id_by_stream.get("^(A|B)$")`
// was always undefined, so the Board projection was never claimed and
// silently stopped counting. This end-to-end test drives the real shape:
// press digits on two source streams, settle, and assert the projection
// saw both. It fails red on the exact-only regression, green with the
// literal-vs-pattern claim contract restored.
type BoardState = Record<(typeof DIGITS)[number], number>;

const DigitBoard = state({
  DigitBoard: z.object(
    Object.fromEntries(DIGITS.map((d) => [d, z.number().int().default(0)]))
  ),
})
  .init(() => Object.fromEntries(DIGITS.map((d) => [d, 0])) as BoardState)
  .emits({ DigitCounted: z.object({ digit: z.enum(DIGITS) }) })
  .patch({
    DigitCounted: ({ data }, s) => ({
      ...s,
      [data.digit]: (s as BoardState)[data.digit] + 1,
    }),
  })
  .on({ CountDigit: z.object({ digit: z.enum(DIGITS) }) })
  .emit("DigitCounted")
  .build();

describe("calculator board projection (regex claim source)", () => {
  afterEach(async () => {
    await dispose()();
  });

  it("projects digits from every stream matched by the ^(A|B)$ source", async () => {
    const actor: Actor = { id: "1", name: "Calculator" };
    const streams = ["A", "B"];

    const app = act()
      .withState(Calculator)
      .withState(DigitBoard)
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
      .build();

    // Press "1" on A and "2" on B — two distinct source streams, both
    // matched only by the regex source, never by an exact-name lookup.
    // Deterministic reaction pump: correlate registers the Board
    // reaction's regex-source subscription, drain fires the CountDigit
    // reactions. A few passes settle each wave.
    const pump = async () => {
      for (let i = 0; i < 3; i++) {
        await app.correlate();
        await app.drain();
      }
    };

    // First wave: press "1" on A. This advances the Board reaction's
    // watermark past the fresh -1 (a fresh subscription is claimable
    // unconditionally regardless of source). After this, the has-work
    // probe must consult the source to decide claimability.
    await app.do("PressKey", { stream: "A", actor }, { key: "1" });
    await pump();

    // Second wave: press "2" on B. B is matched only by the regex source
    // `^(A|B)$`. Post-#1215 exact-only claim, the Board reaction's source
    // never equals a real stream name, so this event is never claimed and
    // the Board silently stops counting — the shipped-demo regression.
    await app.do("PressKey", { stream: "B", actor }, { key: "2" });
    await pump();

    const board = await app.load(DigitBoard, "Board");
    const board_state = board.state as BoardState;
    expect(board_state["1"]).toBe(1);
    expect(board_state["2"]).toBe(1);
  });
});
