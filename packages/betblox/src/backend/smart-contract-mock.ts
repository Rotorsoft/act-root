// Mock smart contract event emitter for local/dev
import { BetBloxEvent } from "../act/schemas";

export function mockContractEvents(cb: (event: BetBloxEvent) => void) {
  // Emit a fake PollCreated event every 5 seconds
  setInterval(() => {
    const event: BetBloxEvent = {
      type: "PollCreated",
      pollId: Math.random().toString(36).slice(2),
      creator: "0xMockUser",
      question: "Will it rain tomorrow?",
      options: ["Yes", "No"],
      closeTime: new Date(Date.now() + 3600_000).toISOString(),
      resolutionCriteria: "Weather API",
      createdAt: new Date().toISOString(),
    };
    cb(event);
  }, 5000);
}
