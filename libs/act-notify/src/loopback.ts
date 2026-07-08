/**
 * @module loopback
 * @category Adapters
 *
 * In-process fan-out broker — the reference {@link Broker}. Useful for
 * tests, for TCK conformance runs, and for the single-process
 * multi-orchestrator case (several Acts over one store in one node
 * process, no external infrastructure).
 */
import type { Broker, BrokerDisposer, BrokerMessage } from "./with-broker.js";

/** Synchronous in-process fan-out to every subscriber. */
export class LoopbackBroker implements Broker {
  private readonly _subscribers = new Set<(message: BrokerMessage) => void>();

  publish(message: BrokerMessage): void {
    for (const handler of this._subscribers) handler(message);
  }

  subscribe(handler: (message: BrokerMessage) => void): BrokerDisposer {
    this._subscribers.add(handler);
    return () => {
      this._subscribers.delete(handler);
    };
  }

  /** Subscribers currently attached — handy in tests. */
  get size(): number {
    return this._subscribers.size;
  }
}
