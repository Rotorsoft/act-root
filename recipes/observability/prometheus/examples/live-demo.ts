/**
 * Interactive: a real app with a live dashboard, driven entirely from
 * the browser, while Grafana reacts beside it.
 *
 *   pnpm dev:metrics        # brings up Prometheus + Grafana + this app
 *
 * The order lifecycle is a real chain — place → pay → ship → deliver —
 * with one reaction per hop, each on its own lane: payments gate the
 * poison SKU, fulfillment ships paid orders, delivery is deliberately
 * flaky and retries with backoff. The dashboard on :4001 shows the
 * projections over SSE; the poison card narrates retries, quarantine,
 * and the operator's fix-and-unblock. The console only launches and
 * tears down (Ctrl-C).
 */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, dispose, projection, state, store } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";
import { z } from "zod";

const Order = state({
  Order: z.object({ sku: z.string(), status: z.string() }),
})
  .init(() => ({ sku: "", status: "new" }))
  .emits({
    OrderPlaced: z.object({ sku: z.string() }),
    OrderPaid: z.object({}),
    OrderShipped: z.object({}),
    OrderDelivered: z.object({}),
  })
  .patch({
    OrderPlaced: (e) => ({ sku: e.data.sku, status: "placed" }),
    OrderPaid: () => ({ status: "paid" }),
    OrderShipped: () => ({ status: "shipped" }),
    OrderDelivered: () => ({ status: "delivered" }),
  })
  .on({ place: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .on({ pay: z.object({}) })
  .emit(() => ["OrderPaid", {}])
  .on({ ship: z.object({}) })
  .emit(() => ["OrderShipped", {}])
  .on({ deliver: z.object({}) })
  .emit(() => ["OrderDelivered", {}])
  .build();

export const stats = { placed: 0, paid: 0, shipped: 0, delivered: 0 };
const OrderStats = projection("order-stats")
  .on({ OrderPlaced: z.object({ sku: z.string() }) })
  .do(async function countPlaced() {
    stats.placed++;
  })
  .on({ OrderPaid: z.object({}) })
  .do(async function countPaid() {
    stats.paid++;
  })
  .on({ OrderShipped: z.object({}) })
  .do(async function countShipped() {
    stats.shipped++;
  })
  .on({ OrderDelivered: z.object({}) })
  .do(async function countDelivered() {
    stats.delivered++;
  })
  .build();

const SYS = { id: "demo", name: "Demo" };

// The payment provider stays broken for the poison SKU until the
// operator "fixes" it — the unblock button models the real move: fix
// the root cause, then release the stream; the stuck order finally
// flows through the whole chain. The next poison order breaks the
// provider again.
let provider_broken = false;

const app = act()
  .withState(Order)
  .withProjection(OrderStats)
  .withLane({ name: "payments", cycleMs: 250, leaseMillis: 3_000 })
  .withLane({ name: "fulfillment", cycleMs: 250 })
  .withLane({ name: "delivery", cycleMs: 250, leaseMillis: 2_000 })
  // Payments: charge every placed order — the poison SKU is the one the
  // provider rejects forever, so its stream retries and then blocks.
  .on("OrderPlaced")
  .do(
    async function charge(event, _stream, a) {
      if (event.data.sku === "poison" && provider_broken)
        throw new Error("payment provider rejects this SKU");
      await a.do("pay", { stream: event.stream, actor: SYS }, {});
    },
    // Backoff is what paces retries on an idle system: its wake timer
    // re-arms the lane at each due time, so the poison stream marches
    // through its budget (~every 3s, blocking on the 4th failure) even
    // with no other traffic.
    { backoff: { strategy: "fixed", baseMs: 3_000, maxMs: 3_000 } }
  )
  .to((e) => ({
    target: `payments:${e.stream}`,
    source: e.stream,
    lane: "payments",
  }))
  // Fulfillment: ship everything that was paid.
  .on("OrderPaid")
  .do(async function ship(event, _stream, a) {
    await a.do("ship", { stream: event.stream, actor: SYS }, {});
  })
  .to((e) => ({
    target: `fulfillment:${e.stream}`,
    source: e.stream,
    lane: "fulfillment",
  }))
  // Delivery: flaky on purpose — ~20% of attempts fail, retry with
  // exponential backoff, and eventually succeed. Watch the delivery
  // lane's ack rate wobble after each batch.
  .on("OrderShipped")
  .do(
    async function deliver(event, _stream, a) {
      if (Math.random() < 0.2) throw new Error("courier hiccup");
      await a.do("deliver", { stream: event.stream, actor: SYS }, {});
    },
    {
      maxRetries: 10,
      backoff: { strategy: "exponential", baseMs: 100, maxMs: 1_000 },
    }
  )
  .to((e) => ({
    target: `delivery:${e.stream}`,
    source: e.stream,
    lane: "delivery",
  }))
  .build();
app.on("committed", () => app.settle());
app.on("error", () => {}); // counted by the bridge; keep the console calm

// The bridge — global registry, served below.
dispose(instrument(app));

// Dashboard plumbing: a rolling event feed and an SSE fanout that
// pushes a fresh snapshot to every connected browser whenever the
// pipeline moves (commits, acks, blocks) — the projections update in
// the page the moment the events land.
const feed: Array<{ name: string; stream: string; sku?: string }> = [];
app.on("committed", (snapshots) => {
  for (const snap of snapshots) {
    const event = snap.event as {
      name: string;
      stream: string;
      data?: { sku?: string };
    };
    feed.unshift({
      name: event.name,
      stream: event.stream,
      sku: event.data?.sku,
    });
  }
  feed.length = Math.min(feed.length, 14);
});

const clients = new Set<ServerResponse>();
async function push() {
  const blocked = await app.blocked_streams();
  // Streams mid-retry (the otherwise-invisible window between a failed
  // attempt and the block): retry climbs on every re-claim. The ":order-"
  // substring matches every reaction target (payments:/fulfillment:/
  // delivery:) without regex beyond the portable grammar.
  const retrying: Array<{ stream: string; retry: number }> = [];
  await store().query_streams(
    (position) => {
      if (position.retry > 0 && !position.blocked)
        retrying.push({ stream: position.stream, retry: position.retry });
    },
    { stream: ":order-" }
  );
  const snapshot = JSON.stringify({
    ...stats,
    blocked: blocked.length,
    retrying,
    feed,
  });
  for (const client of clients) client.write(`data: ${snapshot}\n\n`);
}
// Heartbeat so retry progress shows even when no events commit.
const heartbeat = setInterval(() => {
  if (clients.size > 0) void push();
}, 2_000);
app.on("committed", () => void push());
app.on("acked", () => void push());
app.on("blocked", () => void push());

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"),
  "utf8"
);

const server = createServer((req, res) => {
  if (req.url === "/metrics") {
    void register.metrics().then((m) => {
      res.writeHead(200, { "content-type": register.contentType });
      res.end(m);
    });
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    res.on("close", () => clients.delete(res));
    void push();
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/do/")) {
    const action = req.url.slice(4);
    void (async () => {
      if (action === "batch10") await place(10);
      else if (action === "batch50") await place(50);
      else if (action === "poison") {
        provider_broken = true;
        await place(1, "poison");
      } else if (action === "unblock") {
        provider_broken = false; // fix the root cause first...
        await app.unblock({ blocked: true }); // ...then release the stream
        await push();
      }
    })();
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
server.listen(4001);

let n = 0;
async function place(count: number, sku?: string) {
  for (let i = 0; i < count; i++) {
    n++;
    await app.do(
      "place",
      { stream: `order-${n}`, actor: SYS },
      { sku: sku ?? `sku-${n % 5}` }
    );
  }
}

dispose(async () => {
  clearInterval(heartbeat);
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
});

console.log(`
  the dashboard drives everything — open it and follow the steps there:

      http://localhost:4001

  (Ctrl-C here tears the demo and the containers down)
`);
