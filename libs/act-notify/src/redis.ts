/**
 * @module redis
 * @category Adapters
 *
 * Redis pub/sub {@link Broker}. Sink-injection, zero dependencies: pass
 * connected node-redis clients (v4+ shapes) — redis requires a dedicated
 * connection in subscriber mode, hence the two-client contract. Pub/sub
 * gives true fan-out (every subscribed worker sees every message), which
 * is exactly the wakeup semantic `Store.notify` wants.
 */
import { log } from "@rotorsoft/act";
import type { Broker, BrokerDisposer, BrokerMessage } from "./with-broker.js";

/** The publishing side of a node-redis(v4+)-shaped client. */
export type RedisPublisher = {
  publish(channel: string, message: string): Promise<unknown>;
};

/** A node-redis(v4+)-shaped client in subscriber mode. */
export type RedisSubscriber = {
  subscribe(
    channel: string,
    listener: (message: string) => void
  ): Promise<unknown>;
  /**
   * node-redis v4: with a `listener` argument, removes only that listener;
   * without it, removes **every** listener on the channel. The broker always
   * passes the specific listener so co-subscribers on a shared client survive
   * one subscriber's dispose (#1279).
   */
  unsubscribe(
    channel: string,
    listener?: (message: string) => void
  ): Promise<unknown>;
};

/** Options for {@link RedisBroker}. */
export type RedisBrokerOptions = {
  readonly publisher: RedisPublisher;
  readonly subscriber: RedisSubscriber;
  /** Pub/sub channel name. Default `act:notify`. */
  readonly channel?: string;
};

export const DEFAULT_NOTIFY_CHANNEL = "act:notify";

/**
 * Fan-out over redis pub/sub. Malformed payloads on the channel are
 * dropped with a warning — the channel is a hint path, so garbage
 * degrades latency for one wakeup, never correctness.
 */
export class RedisBroker implements Broker {
  private readonly _publisher: RedisPublisher;
  private readonly _subscriber: RedisSubscriber;
  private readonly _channel: string;

  constructor(options: RedisBrokerOptions) {
    this._publisher = options.publisher;
    this._subscriber = options.subscriber;
    this._channel = options.channel ?? DEFAULT_NOTIFY_CHANNEL;
  }

  async publish(message: BrokerMessage): Promise<void> {
    await this._publisher.publish(this._channel, JSON.stringify(message));
  }

  async subscribe(
    handler: (message: BrokerMessage) => void
  ): Promise<BrokerDisposer> {
    // Capture this subscriber's own listener so dispose removes exactly it —
    // never the co-subscribers sharing this client (#1279). A channel-wide
    // `unsubscribe(channel)` would silence every worker on a shared broker.
    const listener = (raw: string) => {
      try {
        handler(JSON.parse(raw) as BrokerMessage);
      } catch {
        log().warn(
          `Dropping malformed notify payload on "${this._channel}" — remote workers wake on their next poll cycle.`
        );
      }
    };
    await this._subscriber.subscribe(this._channel, listener);
    return async () => {
      await this._subscriber.unsubscribe(this._channel, listener);
    };
  }
}
