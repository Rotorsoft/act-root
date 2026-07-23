import { z } from "zod";
import { act, projection, sensitive, state } from "../src/index.js";
import { sandbox } from "../src/test/index.js";
import type { CacheEntry } from "../src/types/index.js";

/**
 * #1320 — the fold engine must apply the SAME PII treatment on its cold
 * first-sight `load()` path as on its warm incremental path. The warm path
 * folds `pii_strip`ped events (sensitive key removed); the cold path folded
 * via `load()` under the actorless gate (key → `[REDACTED]`). So identical
 * committed histories projected to different rows purely by cache warmth.
 * The fix composes the cold-load view with `pii_strip`; both paths now drop
 * the sensitive key.
 */

const Secret = state({ Secret: z.object({ seen: z.string().optional() }) })
  .init(() => ({}))
  .emits({ Leaked: z.object({ token: sensitive(z.string()) }) })
  // The reducer copies the sensitive field into projected state — a mistake
  // the framework guards by handing sinks stripped events, never PII.
  .patch({ Leaked: ({ data }) => ({ seen: data.token }) })
  .on({ leak: z.object({ token: z.string() }) })
  .emit((p) => ["Leaked", p])
  .build();

const actor = { id: "a", name: "a" };

async function drain_all(app: {
  correlate: () => Promise<unknown>;
  drain: (o: {
    leaseMillis: number;
    eventLimit: number;
  }) => Promise<{ acked: unknown[] }>;
}) {
  await app.correlate();
  for (;;) {
    const d = await app.drain({ leaseMillis: 10_000, eventLimit: 1_000 });
    if (d.acked.length === 0) return;
  }
}

describe("fold PII treatment is path-independent (#1320)", () => {
  it("cold-loaded and warm-folded rows of an identical history match", async () => {
    const table = new Map<string, CacheEntry<{ seen?: string }>>();
    const secrets = projection("secrets")
      .of(Secret)
      .flush(async (rows) => {
        for (const r of rows) table.set(r.stream, { ...r });
      })
      .build();

    const ctx = await sandbox(act().withState(Secret).withProjection(secrets));
    try {
      const app = ctx.app;

      // "warm": e1 first-sights cold, e2 folds warm (drain between commits).
      await app.do("leak", { stream: "warm", actor }, { token: "t1" });
      await drain_all(app);
      await app.do("leak", { stream: "warm", actor }, { token: "t2" });
      await drain_all(app);

      // "cold": both events fold via the first-sight load (single drain).
      await app.do("leak", { stream: "cold", actor }, { token: "t1" });
      await app.do("leak", { stream: "cold", actor }, { token: "t2" });
      await drain_all(app);

      const warm = table.get("warm")?.state;
      const cold = table.get("cold")?.state;

      // Identical histories must project identically regardless of warmth.
      expect(warm).toEqual(cold);
      // And the sensitive key is structurally stripped, never `[REDACTED]`.
      expect(warm).toEqual({});
      expect(cold).toEqual({});
    } finally {
      await ctx.dispose();
    }
  });
});
