# RFC 1279: `RedisSubscriber.unsubscribe` accepts an optional listener

- **Status:** accepted
- **Issue:** #1279
- **Author:** Claude Opus 4.8
- **Created:** 2026-07-18

## Motivation

`RedisBroker.subscribe`'s disposer called `unsubscribe(channel)` with no
listener argument. In node-redis v4 that means "remove **every** listener on the
channel." When one `RedisBroker` is shared by two subscribers (the sidecar+worker
/ one-broker-N-workers topology), disposing one subscriber tore down the other's
wakeups — the surviving worker silently dropped to poll-cycle latency (#1279).

The fix captures each subscription's own listener closure and removes it by
reference (`unsubscribe(channel, listener)` — node-redis v4's two-arg form). To
type that call, the public `RedisSubscriber` structural contract must admit the
optional `listener` parameter.

## Public surface changed

- **`RedisSubscriber.unsubscribe`** (exported from `@rotorsoft/act-notify`) gains
  an optional second parameter:

  ```ts
  // before
  unsubscribe(channel: string): Promise<unknown>;
  // after
  unsubscribe(
    channel: string,
    listener?: (message: string) => void
  ): Promise<unknown>;
  ```

`RedisSubscriber` is the structural shape of the injected node-redis client, not
a class the framework instantiates. The change is **additive and
backward-compatible**: the parameter is optional, so an injected client that
implements either the one- or two-arg form still satisfies the type, and node-
redis v4 already ships the two-arg overload. No other export, method, or type
changes.

## Alternatives considered

- **Track listeners in the broker and re-subscribe survivors after a
  channel-wide unsubscribe.** Rejected: reimplements what node-redis already does
  natively, adds broker state, and races with in-flight messages.
- **Keep the type at one arg and cast at the call site.** Rejected: hides a real
  requirement on the injected client behind an `any`, so a client that genuinely
  can't remove a single listener would fail at runtime instead of at the type
  boundary.

## Stability / charter impact

- Category: **public types** (STABILITY.md). Purely **additive** — one optional
  parameter on an existing structural contract. No rename, removal, or narrowed
  type; existing implementors keep compiling.
- The claim (disposing one subscriber leaves co-subscribers on a shared broker
  intact) is pinned by `brokers.spec.ts` → "disposing one subscriber leaves
  co-subscribers on a shared broker intact (#1279)", whose fake now models
  node-redis's real multi-listener add + by-reference/channel-wide remove.

## Open questions

None.
