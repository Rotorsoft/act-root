import { store } from "@rotorsoft/act";
import {
  PollClosed,
  PollClosedSchema,
  PollCreated,
  PollCreatedSchema,
  VoteCast,
  VoteCastSchema,
  WinningsClaimed,
  WinningsClaimedSchema,
} from "../act/schemas";
import { t } from "./trpc";

export const mockedBlockchainRouter = t.router({
  createMarket: t.procedure
    .input(PollCreatedSchema)
    .mutation(async ({ input }: { input: PollCreated }) => {
      await store().commit("solana", [{ name: "PollCreated", data: input }], {
        correlation: input.pollId,
        causation: {},
      });
      return { status: "emitted", event: "PollCreated", data: input };
    }),
  placeBet: t.procedure
    .input(VoteCastSchema)
    .mutation(async ({ input }: { input: VoteCast }) => {
      await store().commit("solana", [{ name: "VoteCast", data: input }], {
        correlation: input.txHash,
        causation: {},
      });
      return { status: "emitted", event: "VoteCast", data: input };
    }),
  closePoll: t.procedure
    .input(PollClosedSchema)
    .mutation(async ({ input }: { input: PollClosed }) => {
      await store().commit("solana", [{ name: "PollClosed", data: input }], {
        correlation: input.pollId,
        causation: {},
      });
      return { status: "emitted", event: "PollClosed", data: input };
    }),
  claimWinnings: t.procedure
    .input(WinningsClaimedSchema)
    .mutation(async ({ input }: { input: WinningsClaimed }) => {
      await store().commit(
        "solana",
        [{ name: "WinningsClaimed", data: input }],
        {
          correlation: input.txHash,
          causation: {},
        }
      );
      return { status: "emitted", event: "WinningsClaimed", data: input };
    }),
});
