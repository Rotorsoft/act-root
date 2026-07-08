# RFC 0987 — act-notify: the hybrid notify-broker decorator

- **Issue:** [#987](https://github.com/Rotorsoft/act-root/issues/987)
- **Status:** accepted

## Motivation

The scaling ceiling for cross-process wakeups is the Postgres
`LISTEN`/`NOTIFY` subscriber-connection budget — one dedicated listener
connection per worker. `Store.notify` is documented as a hint, not a
contract: correctness comes from `claim()`/drain over the durable store,
so the wakeup channel is swappable without touching durability. This RFC
packages that swap as `@rotorsoft/act-notify`, turning the audit's
"feasible" into "shipped and TCK-proven."

## Surface

New leaf package `@rotorsoft/act-notify` (integration helpers never live
in core). Zero runtime dependencies — brokers take connected client
instances (sink-injection):

| Export | Shape |
|---|---|
| `withBroker(store, broker)` | decorator; delegates every `Store` method to the wrapped adapter, overrides `commit` (publish hint after the delegated commit resolves) and `notify` (subscribe, self-filtering by per-instance origin id). Returns `S & { notify: ... }` — the decorated store always notifies. |
| `Broker`, `BrokerMessage`, `BrokerDisposer` | the broker contract: fan-out `publish`/`subscribe`; messages carry `{ origin, notification }` |
| `LoopbackBroker` | in-process fan-out — reference implementation, TCK runs, tests |
| `RedisBroker` | pub/sub over injected node-redis(v4+)-shaped `publisher`/`subscriber` clients; malformed payloads dropped with a warning |
| `KafkaBroker` | scaffold — throws with guidance (see below) |

## Semantics

- **Hint, never truth.** Publish failures are swallowed and logged; a
  hostile broker (drop/duplicate/reorder) changes nothing about what
  drain processes — pinned by the exactness property test.
- **Self-filtering.** Each decorated instance mints an origin id;
  subscribers drop their own messages, honoring the port's contract that
  `notify` fires only for remote commits.
- **Full delegation.** A `Proxy` rebinds every other member to the
  wrapped adapter (stores keep private state behind `this`), so lease
  semantics, queries, and durability pass the full `runStoreTck` over a
  real `PostgresStore` — the audit's acceptance bar.
- **Not a log shard.** Writes/replay/ordering stay on the wrapped store;
  the recipes cover log-scale walls.

## Kafka: scaffolded, deliberately unimplemented

Wiring a kafkajs-shaped producer/consumer is trivial; the semantics are
not. Consumer groups deliver each message to one consumer per group,
while wakeups need fan-out to every worker — a correct adapter needs a
unique ephemeral `groupId` per process (or manual partition assignment),
latest-offset semantics (stale wakeups are worthless), and a story for
rebalance pauses silently delaying wakeups. Until settled against a real
deployment, `KafkaBroker` throws with that guidance rather than fanning
out incorrectly.

## Alternatives considered

- **Per-broker packages** (`act-notify-kafka`, `-redis`, `-nats` as the
  issue sketched) — rejected: the decorator is the product and it is
  broker-agnostic; one package with a tiny `Broker` contract keeps the
  surface reviewable and lets apps bring any bus in a dozen lines.
- **Broker clients as peer dependencies** — rejected for sink-injection
  (structural client types, zero deps), matching the repo's
  declarative-over-helpers rule and avoiding version pinning.
- **A new core port** (`Notifier`) — rejected: `Store.notify` already is
  the port; the decorator composes at the adapter boundary and core
  stays unchanged.

## Stability impact

New package — additive only. No changes to core, ports, or existing
adapters. Baseline `0.0.0` tag seeded before first merge per the
contributing guide.

## Evidence

- Full `runStoreTck` (incl. #980 lease-semantics cases) over
  `withBroker(PostgresStore, LoopbackBroker)`.
- Exactness property: chaotic broker vs bare store — identical drain
  results.
- Orchestrator end-to-end: a remote instance's commit wakes a local Act
  through the broker alone, no manual pipeline calls.
