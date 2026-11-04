/**
 * A unique value is a state of its own: one stream per value, recording who
 * holds it. Every action that takes or frees a value loads its stream and
 * lists the event, so the rule and the change land in one commit.
 */
import { createHmac } from "node:crypto";
import { sensitive, state, ZodEmpty } from "@rotorsoft/act";
import { z } from "zod";

const HMAC_KEY = process.env.EMAIL_HMAC_KEY ?? "dev-only-key";

/**
 * A stream name can't be forgotten, so the stream of a sensitive value is
 * named by an HMAC of it, never the value. Changing the key means refilling
 * these streams.
 */
export const emailStream = (value: string) =>
  `email-${createHmac("sha256", HMAC_KEY)
    .update(value.trim().toLowerCase())
    .digest("hex")}`;

// ── User email: register, change, deactivate, erase ─────────────────────

export const Email = state({
  Email: z.object({ holder: z.string().optional() }),
})
  .init(() => ({}))
  .emits({
    EmailTaken: z.object({ user: z.string() }),
    EmailReleased: ZodEmpty,
  })
  .patch({
    EmailTaken: ({ data }) => ({ holder: data.user }),
    EmailReleased: () => ({ holder: undefined }),
  })
  .build();

const Register = z.object({ email: z.string().email() });
const EmailEvent = z.object({
  email: sensitive(z.string()),
  emailStream: z.string(),
});

export const User = state({
  // The stream name, not the address: the state must not hold what `forget` erases.
  User: z.object({ emailStream: z.string(), active: z.boolean() }),
})
  .init(() => ({ emailStream: "", active: false }))
  .emits({
    Registered: EmailEvent,
    EmailChanged: EmailEvent,
    Deactivated: ZodEmpty,
  })
  .patch({
    Registered: ({ data }) => ({ emailStream: data.emailStream, active: true }),
    EmailChanged: ({ data }) => ({ emailStream: data.emailStream }),
    Deactivated: () => ({ active: false }),
  })
  .on({ Register }, { maxRetries: 2 })
  .loads(Email, (data) => emailStream(data.email), ["EmailTaken"])
  .requires([
    {
      description: "the email is free",
      holds: (_, __, ___, { Email }) => !Email.holder,
    },
  ])
  .emit((data, _, { stream }) => [
    ["Registered", { email: data.email, emailStream: emailStream(data.email) }],
    ["EmailTaken", { user: stream }],
  ])
  // One state loaded twice: each load takes a name.
  .on({ ChangeEmail: Register }, { maxRetries: 2 })
  .loads(Email, (_, state) => state.emailStream, ["EmailReleased"], "current")
  .loads(Email, (data) => emailStream(data.email), ["EmailTaken"], "next")
  .requires([
    {
      description: "the user is active",
      holds: (_, state) => state.active,
    },
    {
      description: "the new email is free",
      holds: (_, __, ___, { next }) => !next.holder,
    },
  ])
  .emit((data, _, { stream }) => [
    [
      "EmailChanged",
      { email: data.email, emailStream: emailStream(data.email) },
    ],
    ["EmailReleased", {}],
    ["EmailTaken", { user: stream }],
  ])
  // Freeing is an action: `app.close` runs none, so free first, then close.
  .on({ Deactivate: ZodEmpty }, { maxRetries: 2 })
  .loads(Email, (_, state) => state.emailStream, ["EmailReleased"])
  .requires([
    {
      description: "the user is active",
      holds: (_, state) => state.active,
    },
  ])
  .emit(() => [
    ["Deactivated", {}],
    ["EmailReleased", {}],
  ])
  .build();

// ── Vehicle plate: never reissued ───────────────────────────────────────

export const Plate = state({
  Plate: z.object({ vehicle: z.string().optional() }),
})
  .init(() => ({}))
  .emits({ PlateTaken: z.object({ vehicle: z.string() }) })
  .patch({ PlateTaken: ({ data }) => ({ vehicle: data.vehicle }) })
  .build();

const RegisterVehicle = z.object({ plate: z.string() });

export const Vehicle = state({
  Vehicle: z.object({ plate: z.string(), scrapped: z.boolean() }),
})
  .init(() => ({ plate: "", scrapped: false }))
  .emits({ VehicleRegistered: RegisterVehicle, VehicleScrapped: ZodEmpty })
  .patch({
    VehicleRegistered: ({ data }) => ({ plate: data.plate }),
    VehicleScrapped: () => ({ scrapped: true }),
  })
  .on({ RegisterVehicle })
  .loads(Plate, (data) => `plate-${data.plate}`, ["PlateTaken"])
  .requires([
    {
      description: "the plate was never issued",
      holds: (_, __, ___, { Plate }) => !Plate.vehicle,
    },
  ])
  .emit((data, _, { stream }) => [
    ["VehicleRegistered", data],
    ["PlateTaken", { vehicle: stream }],
  ])
  // Scrapping emits nothing to the plate, so it stays taken.
  .on({ ScrapVehicle: ZodEmpty })
  .emit("VehicleScrapped")
  .build();

// ── A token redeemed once ───────────────────────────────────────────────

export const Token = state({
  Token: z.object({ redeemedBy: z.string().optional() }),
})
  .init(() => ({}))
  .emits({ TokenRedeemed: z.object({ by: z.string() }) })
  .patch({ TokenRedeemed: ({ data }) => ({ redeemedBy: data.by }) })
  .build();

const Redeem = z.object({ token: z.string() });

export const Redemption = state({ Redemption: Redeem })
  .init(() => ({ token: "" }))
  .emits({ Redeemed: Redeem })
  .on({ Redeem })
  .loads(Token, (data) => `token-${data.token}`, ["TokenRedeemed"])
  .requires([
    {
      description: "the token is unused",
      holds: (_, __, ___, { Token }) => !Token.redeemedBy,
    },
  ])
  .emit((data, _, { stream }) => [
    ["Redeemed", data],
    ["TokenRedeemed", { by: stream }],
  ])
  .build();

// ── One review per customer per product ─────────────────────────────────

export const Review = state({
  Review: z.object({ posted: z.boolean() }),
})
  .init(() => ({ posted: false }))
  .emits({ ReviewClaimed: ZodEmpty })
  .patch({ ReviewClaimed: () => ({ posted: true }) })
  .build();

const PostReview = z.object({
  customer: z.string(),
  product: z.string(),
  stars: z.number().min(1).max(5),
});

export const Reviewer = state({
  Reviewer: z.object({ reviews: z.number() }),
})
  .init(() => ({ reviews: 0 }))
  .emits({ ReviewPosted: PostReview })
  .patch({ ReviewPosted: (_, state) => ({ reviews: state.reviews + 1 }) })
  .on({ PostReview })
  .loads(Review, (data) => `review-${data.customer}-${data.product}`, [
    "ReviewClaimed",
  ])
  .requires([
    {
      description: "the customer hasn't reviewed this product",
      holds: (_, __, ___, { Review }) => !Review.posted,
    },
  ])
  .emit((data) => [
    ["ReviewPosted", data],
    ["ReviewClaimed", {}],
  ])
  .build();
