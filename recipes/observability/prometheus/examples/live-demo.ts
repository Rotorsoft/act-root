/**
 * Interactive: a real app with a live dashboard, driven from the
 * browser or the console, while the Prometheus UI reacts beside it.
 *
 *   pnpm dev:metrics        # brings up Prometheus + this app
 *
 * The dashboard on :4001 shows the projections updating over SSE as
 * events commit — tiles for placed/shipped/pending/blocked, an event
 * feed, and the same action buttons the console keys drive. Nothing
 * happens until you act. The poison order blocks a fulfillment stream
 * after its retry budget; YOU are the operator who unblocks it and
 * watches both the tile and the Prometheus gauge fall.
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

const UI =
  "http://localhost:9090/graph" +
  "?g0.expr=rate(act_events_committed_total%5B30s%5D)&g0.tab=0" +
  "&g1.expr=act_streams_blocked&g1.tab=0" +
  "&g2.expr=rate(act_reactions_acked_total%5B30s%5D)&g2.tab=0";

// Plain ANSI colors, TTY-gated — no dependency, honest when piped.
const tty = process.stdout.isTTY === true;
const paint = (code: string) => (text: string) =>
  tty ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const yellow = paint("33");
const magenta = paint("35");

const row = (key: string, what: string, effect: string) =>
  `  ${cyan(bold(key))}  ${what.padEnd(26)}${dim(`→ ${effect}`)}`;
const MENU = [
  row("o", "place 10 orders", "commit rate + both lanes light up"),
  row("O", "place 50 orders", "a burst worth graphing"),
  row("p", "place a poison order", "its fulfillment stream blocks in ~30s"),
  row("u", "unblock quarantine", "the operator move: watch the gauge fall"),
  row("s", "show stats", ""),
  row("q", "quit", "tears everything down"),
].join("\n");

// Feedback, then the menu again — the console always tells you what
// you can do next.
const say = (msg: string) => console.log(`\n${msg}\n\n${MENU}\n`);

async function handle(key: string) {
  switch (key) {
    case "o":
      await place(10);
      say(
        green(
          "placed 10 orders — panel 1 spikes, panel 3 shows both lanes working"
        )
      );
      return;
    case "O":
      await place(50);
      say(green("placed 50 orders — a burst the lanes will chew through"));
      return;
    case "p":
      await place(1, "poison");
      say(
        yellow(
          "poison placed — its fulfillment stream retries, then blocks: panel 2 rises in ~30s"
        )
      );
      return;
    case "u": {
      const unblocked = await app.unblock({ blocked: true });
      say(
        unblocked > 0
          ? green(
              `unblocked ${unblocked} stream(s) — panel 2 falls on the next scrape`
            )
          : dim("nothing is blocked right now")
      );
      return;
    }
    case "s": {
      const blocked = await app.blocked_streams();
      say(
        magenta(
          `placed=${stats.placed} shipped=${stats.shipped} blocked=${blocked.length}`
        )
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
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
});

console.log(`
──────────────────────────────────────────────────────────────────
  ${bold("act-otel live demo")} — nothing is running yet; ${bold("you")} drive it.

  1. open the grafana dashboard (2x2, fits one screen, 5s refresh):

     http://localhost:3001/d/act-demo

       commit throughput | blocked stat (goes red)
       per-lane ack rate | blocks + errors

     raw prometheus, if you prefer: ${UI}

  2. open the app dashboard — projections update live over SSE,
     and the buttons there do what the keys below do:

     http://localhost:4001/          live dashboard (tiles + event feed)
     http://localhost:4001/metrics   the raw scrape prometheus reads

  3. come back here and press keys (2s scrape → ~2s to the graph):

${MENU}
──────────────────────────────────────────────────────────────────
`);
