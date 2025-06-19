// Act event types for BetBlox projections

export type PollCreated = {
  type: "PollCreated";
  pollId: string;
  creator: string;
  question: string;
  options: string[];
  closeTime: string; // ISO date
  resolutionCriteria: string;
  createdAt: string; // ISO date
};

export type VoteCast = {
  type: "VoteCast";
  pollId: string;
  voter: string;
  option: string;
  amount: string; // as string for on-chain compatibility
  txHash: string;
  castAt: string; // ISO date
};

export type PollClosed = {
  type: "PollClosed";
  pollId: string;
  outcome: string;
  closedAt: string; // ISO date
  resolver: string;
};

export type WinningsClaimed = {
  type: "WinningsClaimed";
  pollId: string;
  voter: string;
  amount: string;
  claimedAt: string; // ISO date
  txHash: string;
};

export type BetBloxEvent =
  | PollCreated
  | VoteCast
  | PollClosed
  | WinningsClaimed;
