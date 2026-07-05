/**
 * Interactive: an instrumented app you drive from the console while
 * watching the Prometheus UI react.
 *
 *   pnpm dev:metrics        # brings up Prometheus + this app
 *
 * Nothing happens until you press a key — the startup banner walks you
 * through opening the UI pages first, then you fire batches of orders
 * and watch the panels move on the 2s scrape. The poison key blocks a
 * fulfillment stream after its retry budget; YOU are the operator who
 * unblocks it and watches the gauge fall.
 */
import { createServer } from "node:http";
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

const server = createServer((req, res) => {
  if (req.url === "/metrics") {
    void register.metrics().then((m) => {
      res.writeHead(200, { "content-type": register.contentType });
      res.end(m);
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(stats));
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

const UI =
  "http://localhost:9090/graph" +
  "?g0.expr=rate(act_events_committed_total%5B30s%5D)&g0.tab=0" +
  "&g1.expr=act_streams_blocked&g1.tab=0" +
  "&g2.expr=rate(act_reactions_acked_total%5B30s%5D)&g2.tab=0";

const MENU = `  o  place 10 orders          → commit rate + both lanes light up
  O  place 50 orders          → a burst worth graphing
  p  place a poison order     → its fulfillment stream blocks in ~30s
  u  unblock quarantine       → the operator move: watch the gauge fall
  s  show stats
  q  quit (tears everything down)`;

const say = (msg: string) => console.log(`\n${msg}\n`);

async function handle(key: string) {
  switch (key) {
    case "o":
      await place(10);
      say(
        "placed 10 orders — panel 1 spikes, panel 3 shows both lanes working"
      );
      return;
    case "O":
      await place(50);
      say("placed 50 orders — a burst the lanes will chew through");
      return;
    case "p":
      await place(1, "poison");
      say(
        "poison placed — its fulfillment stream retries, then blocks: panel 2 rises in ~30s"
      );
      return;
    case "u": {
      const unblocked = await app.unblock({ blocked: true });
      say(
        unblocked > 0
          ? `unblocked ${unblocked} stream(s) — panel 2 falls on the next scrape`
          : "nothing is blocked right now"
      );
      return;
    }
    case "s": {
      const blocked = await app.blocked_streams();
      say(
        `placed=${stats.placed} shipped=${stats.shipped} blocked=${blocked.length}`
      );
      return;
    }
    case "q":
    case "": // Ctrl-C in raw mode
      console.log();
      await exit("EXIT");
      return;
    default:
      console.log(`\n${MENU}\n`);
  }
}

// Raw single-key input on a TTY; line-buffered when piped (tests/CI).
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const keys = chunk === "" ? [chunk] : [...chunk.trim()];
  for (const key of keys) void handle(key);
});

// dispose() both registers the teardown and returns the exit runner.
const exit = dispose(async () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  await new Promise((resolve) => server.close(resolve));
});

console.log(`
──────────────────────────────────────────────────────────────────
  act-otel live demo — nothing is running yet; you drive it.

  1. open the prometheus UI (three panels pre-loaded):

     ${UI}

       panel 1: commit throughput    panel 2: blocked gauge
       panel 3: per-lane ack rate

  2. optional second tab — the app itself:

     http://localhost:4001/          live projection counts
     http://localhost:4001/metrics   the raw scrape prometheus reads

  3. come back here and press keys (2s scrape → ~2s to the graph):

${MENU}
──────────────────────────────────────────────────────────────────
`);
