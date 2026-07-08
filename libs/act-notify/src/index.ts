/**
 * @module act-notify
 * @category Adapters
 *
 * Hybrid notify-broker decorator for Act stores. `withBroker(store,
 * broker)` delegates every durable Store method to the wrapped adapter
 * and rides an external broker for cross-process wakeups only — lifting
 * the fanout ceiling of store-native channels (Postgres LISTEN/NOTIFY's
 * subscriber-connection budget) without touching durability, leases, or
 * ordering. The broker is a hint path, never the source of truth: drop
 * every message and the poll cycle still drains correctly.
 *
 * It deliberately does NOT shard the durable log — write, replay, and
 * global ordering stay bound to the wrapped store. For log-scale walls,
 * see the partitioning and split-stores recipes.
 */
export { KafkaBroker, type KafkaBrokerOptions } from "./kafka.js";
export { LoopbackBroker } from "./loopback.js";
export {
  DEFAULT_NOTIFY_CHANNEL,
  RedisBroker,
  type RedisBrokerOptions,
  type RedisPublisher,
  type RedisSubscriber,
} from "./redis.js";
export {
  type Broker,
  type BrokerDisposer,
  type BrokerMessage,
  withBroker,
} from "./with-broker.js";
