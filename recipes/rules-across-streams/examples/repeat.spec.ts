import { describe, expect } from "vitest";
import { Email, emailStream, Seats } from "./index.js";
import { at, test } from "./setup.js";

describe("repeating a taking action", () => {
  test("a user registers once, so no address is left held", async ({ app }) => {
    await app.do("Register", at("user-1"), { email: "a@x.io" });
    await expect(
      app.do("Register", at("user-1"), { email: "b@x.io" })
    ).rejects.toThrow("the user isn't registered yet");
    const { state } = await app.load(Email, emailStream("b@x.io"));
    expect(state.holder).toBeUndefined();
  });

  test("a student enrolls once, so one drop frees the seat", async ({
    app,
  }) => {
    await app.do("Enroll", at("e"), { course: "c", student: "s" });
    await expect(
      app.do("Enroll", at("e"), { course: "c", student: "s" })
    ).rejects.toThrow("the student isn't enrolled yet");
    await app.do("Drop", at("e"), {});
    expect((await app.load(Seats, "course-c")).state.taken).toBe(0);
  });
});
