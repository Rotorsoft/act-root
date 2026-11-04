import { PreconditionError, StreamClosedError } from "@rotorsoft/act";
import { describe, expect } from "vitest";
import { Email, emailStream, Plate, Review, User } from "../src/index.js";
import { at, events, rows, test } from "./setup.js";

const ANN = "ann@x.io";

describe("user email", () => {
  test("takes a free address, whatever its case or spacing, and refuses a taken one", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    expect((await app.load(Email, emailStream(ANN))).state.holder).toBe(
      "user-1"
    );
    await expect(
      app.do("Register", at("user-2"), { email: "ANN@x.io" })
    ).rejects.toThrow("the email is free");
    expect(await events("user-2")).toEqual([]);
  });

  test("two users racing for an address: one wins, and the retry refuses the other", async ({
    app,
  }) => {
    const results = await Promise.allSettled([
      app.do("Register", at("user-1"), { email: ANN }),
      app.do("Register", at("user-2"), { email: ANN }),
    ]);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(PreconditionError);
    expect(await events(emailStream(ANN))).toEqual(["EmailTaken"]);
  });

  test("a change frees the old address and takes the new one in one commit", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.do("ChangeEmail", at("user-1"), { email: "ann@y.io" });
    expect(await events("user-1")).toEqual(["Registered", "EmailChanged"]);
    expect(await events(emailStream(ANN))).toEqual([
      "EmailTaken",
      "EmailReleased",
    ]);
    expect((await app.load(Email, emailStream("ann@y.io"))).state.holder).toBe(
      "user-1"
    );
    await app.do("Register", at("user-2"), { email: ANN });
  });

  test("a change to a taken address changes nothing", async ({ app }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.do("Register", at("user-2"), { email: "ben@x.io" });
    await expect(
      app.do("ChangeEmail", at("user-2"), { email: ANN })
    ).rejects.toThrow("the new email is free");
    expect((await app.load(User, "user-2")).state.emailStream).toBe(
      emailStream("ben@x.io")
    );
    expect(await events(emailStream("ben@x.io"))).toEqual(["EmailTaken"]);
  });

  test("a change to the address it already has is a refusal, not a crash", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await expect(
      app.do("ChangeEmail", at("user-1"), { email: ANN })
    ).rejects.toBeInstanceOf(PreconditionError);
    expect(await events("user-1")).toEqual(["Registered"]);
  });

  test("an unregistered user has nothing to change or free", async ({
    app,
  }) => {
    await expect(
      app.do("ChangeEmail", at("ghost"), { email: ANN })
    ).rejects.toBeInstanceOf(PreconditionError);
    await expect(app.do("Deactivate", at("ghost"), {})).rejects.toBeInstanceOf(
      PreconditionError
    );
  });

  test("freeing on close: the closing action frees the address, then the stream closes", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.do("Deactivate", at("user-1"), {});
    const { truncated } = await app.close([{ stream: "user-1" }]);
    expect(truncated.has("user-1")).toBe(true);

    await app.do("Register", at("user-2"), { email: ANN });
    expect((await app.load(Email, emailStream(ANN))).state.holder).toBe(
      "user-2"
    );
    await expect(
      app.do("ChangeEmail", at("user-1"), { email: "ann@y.io" })
    ).rejects.toBeInstanceOf(StreamClosedError);
  });

  test("closing without the action keeps the address taken", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.close([{ stream: "user-1" }]);
    await expect(
      app.do("Register", at("user-2"), { email: ANN })
    ).rejects.toThrow("the email is free");
  });

  test("a closed value's stream refuses whoever loads it", async ({ app }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.do("Deactivate", at("user-1"), {});
    await app.close([{ stream: emailStream(ANN) }]);
    await expect(
      app.do("Register", at("user-2"), { email: ANN })
    ).rejects.toBeInstanceOf(StreamClosedError);
    expect(await events("user-2")).toEqual([]);
  });

  test("erase: after forget, the address is nowhere in the store", async ({
    app,
  }) => {
    await app.do("Register", at("user-1"), { email: ANN });
    await app.do("Deactivate", at("user-1"), {});
    expect(emailStream(ANN)).not.toContain(ANN);
    expect(await rows()).toContain(ANN);

    await app.forget("user-1");
    expect(await rows()).not.toContain(ANN);
    // The value's stream stays, so the address can be taken again.
    await app.do("Register", at("user-2"), { email: ANN });
  });
});

describe("vehicle plate", () => {
  test("is never reissued, even after the vehicle is scrapped", async ({
    app,
  }) => {
    await app.do("RegisterVehicle", at("car-1"), { plate: "ABC" });
    await app.do("ScrapVehicle", at("car-1"), {});
    await expect(
      app.do("RegisterVehicle", at("car-2"), { plate: "ABC" })
    ).rejects.toThrow("the plate was never issued");
    expect((await app.load(Plate, "plate-ABC")).state.vehicle).toBe("car-1");
  });
});

describe("a token", () => {
  test("is redeemed once", async ({ app }) => {
    await app.do("Redeem", at("r-1"), { token: "t1" });
    await expect(app.do("Redeem", at("r-2"), { token: "t1" })).rejects.toThrow(
      "the token is unused"
    );
    await app.do("Redeem", at("r-2"), { token: "t2" });
  });
});

describe("one review per customer per product", () => {
  const review = (customer: string, product: string) => ({
    customer,
    product,
    stars: 5,
  });

  test("refuses a second review, and allows another product or customer", async ({
    app,
  }) => {
    await app.do("PostReview", at("c-1"), review("c1", "p1"));
    await expect(
      app.do("PostReview", at("c-1"), review("c1", "p1"))
    ).rejects.toThrow("hasn't reviewed");
    await app.do("PostReview", at("c-1"), review("c1", "p2"));
    await app.do("PostReview", at("c-2"), review("c2", "p1"));
    expect((await app.load(Review, "review-c1-p1")).state.posted).toBe(true);
  });
});
