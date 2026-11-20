---
id: real-time-recipes
title: Real-time recipes
description: Practical SSE setups for the generated APIs, by screen — one record, a list, a whole page, sensitive states, presence, capacity and several processes.
sidebar_position: 3.6
---

# Real-time recipes

The generated APIs push live state to the browser over SSE (server-sent events, one long HTTP response the server keeps writing to). This page shows what to turn on for each kind of screen, with the server options and the client code side by side. The reference for every option is [Auto-generated API surfaces § Real-time subscriptions](auto-generated-api.md#real-time-subscriptions); the channel and the patch format are in [Real-time with act-http/sse](../concepts/real-time.md).

## Pick by screen

| The screen shows | Subscribe to | Server option |
| --- | --- | --- |
| One record (a ticket, an invoice) | `subscribe.<State>` with its stream | `sse: { channel, publish: true }` |
| A list or dashboard read from a projection | `subscribe.$settled`, then refetch | add `settled: true` |
| Several records, a list, or both, on one page | `subscribe.$live` | add `live: true` |
| Who's viewing or typing | the same subscriptions, plus `channel.overlay(...)` | nothing new |

Every subscription first sends the stream's cached state, when the channel has one (`kind: "state"`), then one `kind: "patch"` frame per commit. Apply each patch with `applyPatchMessage`; when it answers `behind`, the client missed something (a dropped connection, or a backlog that overflowed into a `_resync`), so reopen the subscription for a fresh state.

## The setup used below

A help desk: tickets addressed by stream (`ticket-<n>`), a projection that keeps the open-tickets list, and a customer state that holds an email address. One channel, one router, and every option this page uses:

```ts
import { act, projection, sensitive, state } from "@rotorsoft/act";
import { BroadcastChannel } from "@rotorsoft/act-http/sse";
import { trpc } from "@rotorsoft/act-http/trpc";
import { z } from "zod";

const TicketOpened = z.object({ title: z.string() });

const Ticket = state({
  Ticket: z.object({ title: z.string(), open: z.boolean() }),
})
  .init(() => ({ title: "", open: false }))
  .emits({ TicketOpened, TicketClosed: z.object({}) })
  .patch({
    TicketOpened: ({ data }) => ({ title: data.title, open: true }),
    TicketClosed: () => ({ open: false }),
  })
  .on({ OpenTicket: TicketOpened })
  .emit((data) => ["TicketOpened", data])
  .on({ CloseTicket: z.object({}) })
  .emit(() => ["TicketClosed", {}])
  .build();

// Holds personal data: its commits must never reach a shared channel.
const Customer = state({ Customer: z.object({ email: z.string() }) })
  .init(() => ({ email: "" }))
  .emits({ EmailChanged: z.object({ email: sensitive(z.string()) }) })
  .patch({ EmailChanged: ({ data }) => ({ email: data.email }) })
  .on({ ChangeEmail: z.object({ email: z.string() }) })
  .emit((data) => ["EmailChanged", data])
  .build();

const OpenTickets = projection("open_tickets")
  .on({ TicketOpened })
  .do(async function addTicket() {
    /* insert the row */
  })
  .build();

export const app = act()
  .withState(Ticket)
  .withState(Customer)
  .withProjection(OpenTickets)
  .build();

export const channel = new BroadcastChannel();

type Ctx = { user: { id: string; name: string } };

export const router = trpc(app, {
  actor: (ctx: Ctx) => ctx.user,
  stream: () => "unused", // every state below is addressed by the caller
  streams: { Ticket: /^ticket-\d+$/, Customer: /^customer-\d+$/ },
  // Customer's action is hand-written (recipe 4), so SSE never serves it.
  actions: { exclude: ["ChangeEmail"] },
  sse: {
    channel,
    publish: true, // every commit of a served state goes to the channel
    settled: true, // subscribe.$settled
    live: true, // subscribe.$live
  },
});

export type AppRouter = typeof router;
```

`hono(app, { ...same options })` takes the same `sse` bag and serves the same subscriptions as `GET /api/sse/<State>?stream=…`, `/api/sse/$settled` and `/api/sse/$live`. Two generators can share one channel; each commit is still published once.

## 1. One record on a screen

A ticket page follows the ticket's stream. Keep the last state in a ref, apply patches to it, and reopen when it falls behind:

```tsx no-check
import { applyPatchMessage } from "@rotorsoft/act-http/sse";

function TicketPage({ id }: { id: string }) {
  const cached = useRef<TicketView>();
  const [ticket, setTicket] = useState<TicketView>();
  const sub = trpc.subscribe.Ticket.useSubscription(
    { stream: `ticket-${id}` },
    {
      onData: (frame) => {
        if (frame.kind === "state") cached.current = frame.data;
        else {
          const result = applyPatchMessage(frame.data, cached.current);
          if (!result.ok) {
            // "stale": the patch is older than what we hold (a mutation's
            // response got here first). "behind": we missed versions.
            if (result.reason === "behind") sub.reset();
            return;
          }
          cached.current = result.state;
        }
        setTicket(cached.current);
      },
    }
  );
  // ...
}
```

Without tRPC, the Hono route is a plain `EventSource`. Each frame arrives as an SSE event named after its kind:

```ts no-check
const source = new EventSource(`/api/sse/Ticket?stream=ticket-${id}`);
source.addEventListener("state", (e) => seed(JSON.parse(e.data)));
source.addEventListener("patch", (e) => patch(JSON.parse(e.data)));
// "ping" events are the heartbeat; ignore them.
```

A stream outside the state's pattern (`streams.Ticket`) is refused when the subscription opens (`422` on Hono, `UNPROCESSABLE_CONTENT` on tRPC), so a client can't subscribe to another state's records through `subscribe.Ticket`.

## 2. A list that follows a projection

A list reads a projection, and a projection catches up after the commit, when the app settles. Refetching on a ticket's patch would read the old rows. Refetch when `$settled` says the projection moved instead, and debounce, because one settle can send several frames:

```tsx no-check
function OpenTicketsList() {
  const utils = trpc.useUtils();
  const refetch = useMemo(
    () => debounce(() => utils.openTickets.invalidate(), 100),
    [utils]
  );
  trpc.subscribe.$settled.useSubscription(undefined, {
    onData: ({ data }) => {
      if (data.targets.includes("open_tickets")) refetch();
    },
  });
  const list = trpc.openTickets.useQuery(); // your hand-written query
  // ...
}
```

`targets` names what each drain advanced: projections by their target name, reactions by the streams they write to. A frame waiting for a slow client absorbs the next settle's targets, so a list never misses that it changed.

## 3. A page that shows several things

A browser opens at most six connections to one origin over HTTP/1.1, which is what a plain Node server speaks. A page with a ticket, its customer's other ticket and the open list holds three subscriptions; two such tabs and a third stalls. `$live` carries all of a page's sources on one connection:

```tsx no-check
trpc.subscribe.$live.useSubscription(
  { streams: { Ticket: ["ticket-41", "ticket-42"] }, settled: true },
  {
    onData: (frame) => {
      if (frame.kind === "settled") {
        if (frame.data.targets.includes("open_tickets")) refetch();
        return;
      }
      // frame.state and frame.stream say which record this is; keep one
      // cached state per stream and apply patches per stream, as in recipe 1.
      apply(frame.stream, frame);
    },
  }
);
```

On Hono, list each stream under its state name and add `settled=1`:

```ts no-check
const source = new EventSource(
  "/api/sse/$live?Ticket=ticket-41&Ticket=ticket-42&settled=1"
);
source.addEventListener("patch", (e) => {
  const { state, stream, data } = JSON.parse(e.data);
  apply(stream, data);
});
source.addEventListener("settled", (e) => refetchLists(JSON.parse(e.data).targets));
```

One `$live` takes one slot of `maxConnections` and follows up to `maxStreamsPerSubscription` streams (default 50). Its streams share one backlog: when a stream overflows it, that stream's pending frames give way to one `_resync`, which `applyPatchMessage` reports as `behind`, and the other streams keep theirs. To change what the page follows, open a new `$live` with the new list and close the old one.

## 4. Keeping a sensitive state off the channel

The channel caches one state per stream, folded with whichever actor committed last, and sends it to every subscriber. A state whose events declare `sensitive(...)` fields would hand one person's email to everyone, so generating `sse` refuses it at build.

The refusal covers only the states the generated actions reach. The setup above leaves `ChangeEmail` out with `actions: { exclude: [...] }`, so `Customer` is neither served nor published, and SSE works for the rest. Write the customer's procedure by hand and answer it with the caller's own view:

```ts no-check
const customerRouter = t.router({
  changeEmail: t.procedure
    .input(z.object({ stream: z.string(), email: z.string().email() }))
    .mutation(({ ctx, input }) =>
      app.do("ChangeEmail", { stream: input.stream, actor: ctx.user }, { email: input.email })
    ),
});
export const appRouter = t.mergeRouters(router, customerRouter);
```

`actions: { include: [...] }` works the same way from the other side: only the listed actions are generated, and only the states they reach are served.

## 5. Presence and other changes without an event

Who's viewing a ticket is not an event; it changes the screen, not the record. Send it with `channel.overlay`, next to `publish: true`. The overlay merges into the cached state without changing its version, and a caught-up client applies it through the same `applyPatchMessage`:

```ts no-check
import { PresenceTracker } from "@rotorsoft/act-http/sse";

const presence = new PresenceTracker();

// From a small hand-written route the page calls on open and on close:
function viewing(stream: string, user: string, on: boolean) {
  if (on) presence.add(stream, user);
  else presence.remove(stream, user);
  channel.overlay(stream, { viewers: presence.online(stream) });
}
```

The overlay survives the next commit, so a client that reconnects sees the same viewers. Write your own `committed` listener instead of `publish: true` only when every commit must carry computed fields the state doesn't have.

## 6. Capacity

Each generator counts its open subscriptions. The defaults fit a business app with up to a few hundred viewers per process:

| Option | Default | Change it when |
| --- | --- | --- |
| `maxConnections` | `500` | more viewers per process than that; above 10,000 run more processes instead |
| `heartbeatMs` | `30_000` | a proxy closes idle connections sooner than 30 s |
| `maxPendingPerConnection` | `256` | a busy stream sends bursts larger than that to clients that pause |
| `maxStreamsPerSubscription` | `50` | a `$live` page follows more streams |
| `onConnections` | — | you want the open count on a metric |

```ts no-check
sse: {
  channel,
  publish: true,
  live: true,
  maxConnections: 2_000,
  heartbeatMs: 20_000,
  onConnections: (count) => openSubscriptions.set(count), // a gauge
},
```

The subscription past the cap is refused (`503` on Hono, `TOO_MANY_REQUESTS` on tRPC), never left hanging. Over HTTP/2 the browser's six-connection limit goes away, but `$live` still saves a slot and a heartbeat per stream.

## 7. More than one server process

The channel lives in memory. A viewer connected to one process sees that process's commits and drains only. Run the processes behind a load balancer with sticky sessions, and route a viewer to the process that serves its writes. To see writes made elsewhere, bridge the app's `notified` lifecycle event into `channel.publish`: the notification carries no snapshot, so load the stream first. [Horizontal scaling](auto-generated-api.md#horizontal-scaling) has the details.

## See it running

`pnpm dev:http` runs the calculator over both transports with `publish: true`; `packages/client/src/Calculator.tsx` is recipe 1 in full.
