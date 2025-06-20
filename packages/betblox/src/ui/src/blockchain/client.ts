import { trpc } from "../trpc";

export const blockchainClient = {
  useCreateMarket: () => trpc.blockchain.createMarket.useMutation(),
  usePlaceBet: () => trpc.blockchain.placeBet.useMutation(),
  useClosePoll: () => trpc.blockchain.closePoll.useMutation(),
  useClaimWinnings: () => trpc.blockchain.claimWinnings.useMutation(),
};
