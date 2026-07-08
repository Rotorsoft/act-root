/**
 * @module kafka
 * @category Adapters
 *
 * Kafka {@link Broker} — SCAFFOLD, not implemented. The wiring is not
 * the hard part (a kafkajs-shaped producer/consumer pair mirrors the
 * redis adapter); the semantics are: Kafka consumer groups deliver each
 * message to ONE consumer per group, while `Store.notify` needs fan-out
 * to EVERY worker. A correct implementation must give each process a
 * unique, ephemeral `groupId` (or use manual partition assignment
 * without groups), decide offset semantics (`latest` — old wakeups are
 * worthless), and handle rebalance pauses that silently delay wakeups.
 * Until those choices are settled against a real deployment, this
 * adapter refuses loudly instead of fanning out incorrectly.
 */
import type { Broker, BrokerDisposer, BrokerMessage } from "./with-broker.js";

/** Options the eventual implementation will take (kafkajs shapes). */
export type KafkaBrokerOptions = {
  /** Topic carrying wakeup hints. Default `act-notify`. */
  readonly topic?: string;
};

const GUIDANCE =
  "KafkaBroker is a scaffold: fan-out semantics (unique per-process groupId, latest-offset, rebalance pauses) are not settled. Use RedisBroker or LoopbackBroker, or contribute the implementation.";

/** Refuses loudly until fan-out semantics are implemented. */
export class KafkaBroker implements Broker {
  readonly topic: string;

  constructor(options: KafkaBrokerOptions = {}) {
    this.topic = options.topic ?? "act-notify";
  }

  publish(_message: BrokerMessage): void {
    throw new Error(GUIDANCE);
  }

  subscribe(_handler: (message: BrokerMessage) => void): BrokerDisposer {
    throw new Error(GUIDANCE);
  }
}
