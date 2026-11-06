/**
 * Against a real server: the default `fetch` follows a redirect and turns the
 * POST into a bodyless GET, so a constructed `Response` can't prove this.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { act, InMemoryCache, InMemoryStore, state } from "@rotorsoft/act";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { webhook } from "../src/webhook/index.js";

const T = state({ T: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Hit: z.object({ v: z.string() }) })
  .patch({ Hit: (_, s) => ({ n: s.n + 1 }) })
  .on({ Do: z.object({ v: z.string() }) })
  .emit("Hit")
  .build();

describe("webhook against a redirect", () => {
  it("blocks on a real redirect, with one POST", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      if (req.url === "/moved") {
        res.writeHead(301, { location: "/landing" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const { port } = server.address() as AddressInfo;
    const app = act()
      .withState(T)
      .on("Hit")
      .do(webhook({ url: `http://127.0.0.1:${port}/moved` }))
      .to("out")
      .build({
        autoSettle: false,
        scoped: { store: new InMemoryStore(), cache: new InMemoryCache() },
      });
    let blocked = 0;
    app.on("blocked", (b) => {
      blocked += b.length;
    });
    await app.do(
      "Do",
      { stream: "s", actor: { id: "a", name: "a" } },
      { v: "x" }
    );
    for (let i = 0; i < 3; i++) {
      await app.correlate();
      await app.drain({ leaseMillis: 1 });
    }
    await app.shutdown();
    server.close();
    expect(seen).toEqual(["POST /moved"]);
    expect(blocked).toBe(1);
  });
});
