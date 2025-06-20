import { EventEmitter } from "events";

// Singleton event emitter for the mock blockchain
export const blockchainEventEmitter = new EventEmitter();

export const mockContract = {
  createMarket: (marketData: any) => {
    const event = {
      type: "MarketCreated",
      data: marketData,
      timestamp: Date.now(),
    };
    blockchainEventEmitter.emit("MarketCreated", event);
    return event;
  },
  placeBet: (betData: any) => {
    const event = {
      type: "BetPlaced",
      data: betData,
      timestamp: Date.now(),
    };
    blockchainEventEmitter.emit("BetPlaced", event);
    return event;
  },
  // Add more contract methods as needed
};
