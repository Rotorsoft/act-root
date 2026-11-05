import { fixture } from "@rotorsoft/act/test";
import { describe, expect } from "vitest";
import { builder, fill } from "./fill-streams.js";
import { Email, emailStream } from "./unique-values.js";

const test = fixture(builder);
const actor = { id: "a", name: "a" };

describe("filling the streams of a new rule", () => {
  test("takes each customer's address", async ({ app }) => {
    const email = emailStream("ann@example.com");
    await app.do("SignUp", { stream: "ann", actor }, { emailStream: email });

    expect(await fill(app)).toEqual({
      filled: 1,
      skipped: 0,
      duplicates: [],
    });
    expect((await app.load(Email, email)).state.holder).toBe("ann");
  });

  test("changes nothing when it runs twice", async ({ app }) => {
    const email = emailStream("ann@example.com");
    await app.do("SignUp", { stream: "ann", actor }, { emailStream: email });
    await fill(app);
    const before = (await app.load(Email, email)).version;

    expect(await fill(app)).toEqual({
      filled: 0,
      skipped: 1,
      duplicates: [],
    });
    expect((await app.load(Email, email)).version).toBe(before);
  });

  test("reports a duplicate, every time, and keeps the first holder", async ({
    app,
  }) => {
    const email = emailStream("ann@example.com");
    await app.do("SignUp", { stream: "ann", actor }, { emailStream: email });
    await app.do("SignUp", { stream: "bob", actor }, { emailStream: email });

    const expected = { skipped: 0, duplicates: ["bob"] };
    expect(await fill(app)).toEqual({ filled: 1, ...expected });
    expect(await fill(app)).toEqual({
      filled: 0,
      skipped: 1,
      duplicates: ["bob"],
    });
    expect((await app.load(Email, email)).state.holder).toBe("ann");
  });

  test("the second run catches a customer who signed up in between", async ({
    app,
  }) => {
    await app.do(
      "SignUp",
      { stream: "ann", actor },
      { emailStream: emailStream("ann@example.com") }
    );
    await fill(app);
    await app.do(
      "SignUp",
      { stream: "bob", actor },
      { emailStream: emailStream("bob@example.com") }
    );

    expect(await fill(app)).toEqual({
      filled: 1,
      skipped: 1,
      duplicates: [],
    });
  });
});
