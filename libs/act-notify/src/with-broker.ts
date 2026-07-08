/**
 * @module with-broker
 * @category Adapters
 *
 * Hybrid notify-broker decorator. Wraps a durable {@link Store} and rides
 * an external broker for cross-process wakeups, lifting the fanout
 * ceiling of store-native channels (Postgres `LISTEN`/`NOTIFY` caps at
 * the subscriber-connection budget). Every durable method delegates to
 * the wrapped adapter untouched — the broker carries hints only, never
 * truth: correctness still comes from `claim()`/drain over the store,
 * exactly per the `Store.notify` "hint, not a contract" clause.
 */
import { randomUUID } from "node:crypto";
import type {
  Committed,
  EventMeta,
  Message,
  Schemas,
  Store,
  StoreNotification,
} from "@rotorsoft/act";
import { log } from "@rotorsoft/act";

/**
 * The wire shape brokers carry. `origin` implements the port's
 * self-filtering contract: subscribers drop messages published by their
 * own store instance, so only genuinely remote commits wake the local
 * orchestrator.
 */
export type BrokerMessage = {
  readonly origin: string;
  readonly notification: StoreNotification;
};

/** Disposer releasing a broker subscription. */
export type BrokerDisposer = () => void | Promise<void>;

/**
 * Minimal broker contract — publish one message to every subscriber on
 * the channel (fan-out semantics; a queue that delivers to one consumer
 * starves every other worker's wakeup).
 */
export type Broker = {
  publish(message: BrokerMessage): void | Promise<void>;
  subscribe(
    handler: (message: BrokerMessage) => void
  ): BrokerDisposer | Promise<BrokerDisposer>;
};

/**
 * Wrap a durable store so commits publish wakeup hints to the broker and
 * `notify` subscribes to it — leaving every other Store method, and
 * therefore every durability/lease/ordering guarantee, untouched.
 *
 * The wrapped store's own `notify` (if any) is shadowed, not exercised:
 * construct the base adapter with its native channel disabled (e.g.
 * `new PostgresStore({ notify: false })`) to avoid paying for both.
 *
 * Publish failures are swallowed and logged — a broker outage degrades
 * cross-process latency to the poll cycle, never a commit.
 *
 * @param store - The durable adapter that remains the source of truth
 * @param broker - The wakeup channel (fan-out)
 * @returns A store of the same shape with broker-backed notifications
 */
export function withBroker<S extends Store>(
  store: S,
  broker: Broker
): S & { notify: NonNullable<Store["notify"]> } {
  const origin = randomUUID();

  const commit = async <E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ): Promise<Committed<E, keyof E>[]> => {
    const committed = await store.commit(stream, msgs, meta, expectedVersion);
    if (committed.length > 0) {
      const notification: StoreNotification = {
        stream,
        events: committed.map(({ id, name }) => ({
          id,
          name: name as string,
        })),
      };
      try {
        await broker.publish({ origin, notification });
      } catch (error) {
        // Hint, not a contract: listeners fall back to the poll path.
        log().warn(
          `Broker publish failed for stream "${stream}": ${
            error instanceof Error ? error.message : String(error)
          } — remote workers wake on their next poll cycle.`
        );
      }
    }
    return committed;
  };

  const notify = (handler: (notification: StoreNotification) => void) =>
    broker.subscribe((message) => {
      // Self-filtering contract: only remote commits wake this process.
      if (message.origin !== origin) handler(message.notification);
    });

  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "commit") return commit;
      if (prop === "notify") return notify;
      const value = Reflect.get(target, prop, receiver);
      // Rebind methods to the wrapped adapter — stores keep private
      // state behind `this`, and a proxied receiver would break it.
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as S & { notify: NonNullable<Store["notify"]> };
}
