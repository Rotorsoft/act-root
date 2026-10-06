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
 * The notification inside a broker message, checked the way the Postgres
 * listener checks its own payloads: `stream` must be a string, and only
 * `{ id: number, name: string }` events are kept. Anything else — a
 * foreign or version-skewed publisher on a shared channel — yields
 * `undefined` and is skipped.
 */
function well_formed(raw: unknown): StoreNotification | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { stream, events } = raw as { stream?: unknown; events?: unknown };
  if (typeof stream !== "string" || !Array.isArray(events)) return undefined;
  const kept = events.filter(
    (e): e is { id: number; name: string } =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { id?: unknown }).id === "number" &&
      typeof (e as { name?: unknown }).name === "string"
  );
  return kept.length
    ? { stream, events: kept.map(({ id, name }) => ({ id, name })) }
    : undefined;
}

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
      // Hint, not a contract: the publish must never gate the durable
      // write's return. Invoke it synchronously (so an in-process broker
      // fans out before commit resolves) but do NOT await the result — a
      // slow, hung, or rejecting broker degrades cross-process latency to
      // the poll cycle, never a commit.
      const warn = (error: unknown) =>
        log().warn(
          `Broker publish failed for stream "${stream}": ${
            error instanceof Error ? error.message : String(error)
          } — remote workers wake on their next poll cycle.`
        );
      try {
        void Promise.resolve(broker.publish({ origin, notification })).catch(
          warn
        );
      } catch (error) {
        // Synchronous throw from a synchronous broker (e.g. Loopback).
        warn(error);
      }
    }
    return committed;
  };

  // The subscription is a hint too, so it must never hold the orchestrator
  // up. `notify` returns at once, and the broker's subscribe and
  // unsubscribe run in the background with failures logged: a broker that
  // stalls (a client that queues commands while disconnected) would
  // otherwise hang `act().build()`'s wiring or `app.shutdown()` before its
  // grace budget is ever consulted. The local disposer stops delivery
  // synchronously, so a late message can't wake a worker that is
  // shutting down even while the broker's own unsubscribe is stuck.
  const notify = (handler: (notification: StoreNotification) => void) => {
    let live = true;
    const warn = (what: string) => (error: unknown) =>
      log().warn(
        `Broker ${what} failed: ${
          error instanceof Error ? error.message : String(error)
        } — remote workers wake on their next poll cycle.`
      );
    const subscribed = broker.subscribe((message) => {
      // Self-filtering contract: only remote commits wake this process.
      if (!live || message?.origin === origin) return;
      const notification = well_formed(message?.notification);
      if (!notification) {
        log().warn("Broker delivered a malformed notification, skipping");
        return;
      }
      // A throwing handler must not reach the broker: an in-process
      // broker fans out in a plain loop (one throw would starve every
      // later subscriber) and its publish runs inside the committing
      // process's `commit`.
      try {
        handler(notification);
      } catch (error) {
        log().error(error, "Broker notification handler threw");
      }
    });
    const release = (disposer: BrokerDisposer) => {
      try {
        void Promise.resolve(disposer()).catch(warn("unsubscribe"));
      } catch (error) {
        warn("unsubscribe")(error);
      }
    };
    if (typeof subscribed !== "function") subscribed.catch(warn("subscribe"));
    return () => {
      live = false;
      if (typeof subscribed === "function") release(subscribed);
      else subscribed.then(release, () => {});
    };
  };

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
