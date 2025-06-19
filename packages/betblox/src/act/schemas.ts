import { z } from "zod/v4";

export const PollCreatedSchema = z.object({
  type: z.literal("PollCreated"),
  pollId: z.string(),
  creator: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  closeTime: z.string(), // ISO date
  resolutionCriteria: z.string(),
  createdAt: z.string(), // ISO date
});

export const VoteCastSchema = z.object({
  type: z.literal("VoteCast"),
  pollId: z.string(),
  voter: z.string(),
  option: z.string(),
  amount: z.string(), // as string for on-chain compatibility
  txHash: z.string(),
  castAt: z.string(), // ISO date
});

export const PollClosedSchema = z.object({
  type: z.literal("PollClosed"),
  pollId: z.string(),
  outcome: z.string(),
  closedAt: z.string(), // ISO date
  resolver: z.string(),
});

export const WinningsClaimedSchema = z.object({
  type: z.literal("WinningsClaimed"),
  pollId: z.string(),
  voter: z.string(),
  amount: z.string(),
  claimedAt: z.string(), // ISO date
  txHash: z.string(),
});

export const BetBloxEventSchema = z.discriminatedUnion("type", [
  PollCreatedSchema,
  VoteCastSchema,
  PollClosedSchema,
  WinningsClaimedSchema,
]);

export type PollCreated = z.infer<typeof PollCreatedSchema>;
export type VoteCast = z.infer<typeof VoteCastSchema>;
export type PollClosed = z.infer<typeof PollClosedSchema>;
export type WinningsClaimed = z.infer<typeof WinningsClaimedSchema>;
export type BetBloxEvent = z.infer<typeof BetBloxEventSchema>;
