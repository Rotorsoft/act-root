import { describe, expect } from "vitest";
import { Cart } from "./index.js";
import { at, events, rival_before_commit, test } from "./setup.js";

describe("the displayed price", () => {
  const add = (price: number) => ({ product: "p-7", price });

  test("is checked against the product, and the product gets no event", async ({
    app,
  }) => {
    await app.do("SetPrice", at("p-7"), { price: 10 });
    await app.do("AddToCart", at("cart-1"), add(10));
    expect(await events("p-7")).toEqual(["PriceSet"]);
    expect((await app.load(Cart, "cart-1")).state.total).toBe(10);
    await expect(app.do("AddToCart", at("cart-1"), add(9))).rejects.toThrow(
      "the displayed price is current"
    );
  });

  test("a price change between the load and the commit doesn't stop it: a read isn't guarded", async ({
    app,
  }) => {
    await app.do("SetPrice", at("p-7"), { price: 10 });
    rival_before_commit(() => app.do("SetPrice", at("p-7"), { price: 12 }));
    await app.do("AddToCart", at("cart-1"), add(10));
    expect((await app.load(Cart, "cart-1")).state.total).toBe(10);
  });
});
