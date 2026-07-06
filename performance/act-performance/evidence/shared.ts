/** Shared bits for the envelope-evidence scenarios. */
import { act, state } from "@rotorsoft/act";
import { z } from "zod";

export function config() {
  const arg = (name: string, dflt: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : dflt;
  };
  return {
    pg: {
      host: process.env.PG_HOST ?? "localhost",
      port: Number(process.env.PG_PORT ?? 5431),
      user: process.env.PG_USER ?? "postgres",
      password: process.env.PG_PASSWORD ?? "postgres",
      database: process.env.PG_DATABASE ?? "postgres",
    },
    table: process.env.EVIDENCE_TABLE ?? "evidence",
    events: arg("events", 1_000_000),
    hot: arg("hot", 100_000),
  };
}

/** The measured aggregate: one integer, one event — floor-cost shape. */
export const Counter = state({ Counter: z.object({ n: z.number() }) })
  .init(() => ({ n: 0 }))
  .emits({ Ticked: z.object({ n: z.number() }) })
  .patch({ Ticked: (e) => ({ n: e.data.n }) })
  .on({ tick: z.object({ n: z.number() }) })
  .emit((a) => ["Ticked", a])
  .build();

export const buildApp = () => act().withState(Counter).build();

export const ACTOR = { id: "evidence", name: "Evidence" };

export const human = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString();

export const elapsed = (t0: bigint) => {
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return ms >= 60_000
    ? `${(ms / 60_000).toFixed(1)}min`
    : ms >= 1_000
      ? `${(ms / 1_000).toFixed(1)}s`
      : `${ms.toFixed(0)}ms`;
};

export const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
