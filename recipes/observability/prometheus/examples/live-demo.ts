/**
 * Interactive: a real app with a live dashboard, driven from the
 * browser or the console, while the Prometheus UI reacts beside it.
 *
 *   pnpm dev:metrics        # brings up Prometheus + this app
 *
 * The dashboard on :4001 is the cockpit: a guided three-step strip,
 * links to grafana and prometheus, action buttons firing batches, and
 * projection tiles + an event feed updating over SSE as events commit.
 * The poison button blocks a fulfillment stream after its retry
 * budget; YOU are the operator who unblocks it and watches both the
 * tile and the grafana stat fall. The console only launches and
 * tears down (Ctrl-C).
 */
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, dispose, projection, state } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";
import { z } from "zod";

const Order = state({
  Order: z.object({ sku: z.string(), shipped: z.boolean() }),
})
  .init(() => ({ sku: "", shipped: false }))
  .emits({
    OrderPlaced: z.object({ sku: z.string() }),
    OrderShipped: z.object({}),
  })
  .patch({
    OrderPlaced: (e) => ({ sku: e.data.sku }),
    OrderShipped: () => ({ shipped: true }),
  })
  .on({ place: z.object({ sku: z.string() }) })
  .emit((a) => ["OrderPlaced", a])
  .on({ ship: z.object({}) })
  .emit(() => ["OrderShipped", {}])
  .build();

export const stats = { placed: 0, shipped: 0 };
const OrderStats = projection("order-stats")
  .on({ OrderPlaced: z.object({ sku: z.string() }) })
  .do(async function countPlaced() {
    stats.placed++;
  })
  .on({ OrderShipped: z.object({}) })
  .do(async function countShipped() {
    stats.shipped++;
  })
  .build();

const SYS = { id: "demo", name: "Demo" };

const app = act()
  .withState(Order)
  .withProjection(OrderStats)
  .withLane({ name: "fulfillment", cycleMs: 250 })
  .withLane({ name: "notifications", cycleMs: 250, leaseMillis: 2_000 })
  // Fulfillment: ships every placed order — unless it's the poison SKU,
  // which never succeeds and blocks its stream after the retry budget.
  .on("OrderPlaced")
  .do(async function fulfill(event, _stream, a) {
    if (event.data.sku === "poison") throw new Error("downstream rejects");
    await a.do("ship", { stream: event.stream, actor: SYS }, {});
  })
  .to((e) => ({
    target: `fulfillment:${e.stream}`,
    source: e.stream,
    lane: "fulfillment",
  }))
  // Notifications: flaky on purpose — ~20% of attempts fail, retry with
  // exponential backoff, and eventually succeed. Watch the acked rate on
  // the notifications lane wobble after each batch.
  .on("OrderShipped")
  .do(
    async function notify() {
      if (Math.random() < 0.2) throw new Error("smtp hiccup");
    },
    {
      maxRetries: 10,
      backoff: { strategy: "exponential", baseMs: 100, maxMs: 1_000 },
    }
  )
  .to((e) => ({
    target: `notify:${e.stream}`,
    source: e.stream,
    lane: "notifications",
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
  feed.length = Math.min(feed.length, 12);
});

const clients = new Set<ServerResponse>();
async function push() {
  const blocked = await app.blocked_streams();
  const snapshot = JSON.stringify({
    ...stats,
    blocked: blocked.length,
    feed,
  });
  for (const client of clients) client.write(`data: ${snapshot}\n\n`);
}
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
      else if (action === "poison") await place(1, "poison");
      else if (action === "unblock") {
        await app.unblock({ blocked: true });
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
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
});

console.log(`
  the dashboard drives everything — open it and follow the steps there:

      http://localhost:4001

  (Ctrl-C here tears the demo and the containers down)
`);
