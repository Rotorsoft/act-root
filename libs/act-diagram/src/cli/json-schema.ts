/**
 * Emit each event's Zod schema as JSON Schema, plus the producer/consumer
 * graph in a stable JSON shape. Consumers in other services can:
 *
 *   const ajv = new Ajv({ strict: false });
 *   const validate = ajv.compile(report.events.OrderPlaced.schema);
 *   if (!validate(payload)) throw new Error(JSON.stringify(validate.errors));
 *
 * The output is intentionally machine-readable, not pretty: pipe it to
 * `jq` or commit it under `contracts/` for downstream consumption.
 *
 * `z.toJSONSchema()` (Zod v4) does the heavy lifting; we wrap each call
 * in a try/catch because not every Zod schema (e.g. those with custom
 * transforms) has a clean JSON representation.
 */
import { z } from "zod";
import type { DomainModel } from "../client/types/index.js";
import { type ContractIndex, eventStatus } from "./contract-index.js";

type EventReport = {
  name: string;
  file?: string;
  line?: number;
  status: "active" | "deprecated";
  supersededBy?: string;
  schemaText?: string;
  schema?: unknown;
  schemaError?: string;
  producers: Array<{
    action: string;
    state: string;
    file?: string;
    line?: number;
  }>;
  consumers: Array<
    | {
        type: "reaction";
        slice?: string;
        handler: string;
        dispatches: string[];
        file?: string;
        line?: number;
      }
    | { type: "projection"; name: string; file?: string }
  >;
};

type Report = {
  $schema: string;
  generator: string;
  generatedAt: string;
  counts: {
    states: number;
    slices: number;
    projections: number;
    events: number;
  };
  events: Record<string, EventReport>;
};

const findProducers = (model: DomainModel, eventName: string) => {
  const out: EventReport["producers"] = [];
  for (const st of model.states) {
    for (const act of st.actions) {
      if (act.emits.includes(eventName)) {
        out.push({
          action: act.name,
          state: st.name,
          file: st.file,
          line: act.line,
        });
      }
    }
  }
  return out;
};

const findConsumers = (
  model: DomainModel,
  eventName: string
): EventReport["consumers"] => {
  const out: EventReport["consumers"] = [];
  for (const sl of model.slices) {
    for (const r of sl.reactions) {
      if (r.event === eventName) {
        out.push({
          type: "reaction",
          slice: sl.name,
          handler: r.handlerName,
          dispatches: r.dispatches,
          file: r.file ?? sl.file,
          line: r.line,
        });
      }
    }
  }
  for (const r of model.reactions) {
    if (r.event === eventName) {
      out.push({
        type: "reaction",
        handler: r.handlerName,
        dispatches: r.dispatches,
        file: r.file,
        line: r.line,
      });
    }
  }
  for (const p of model.projections) {
    if (p.handles.includes(eventName)) {
      out.push({ type: "projection", name: p.name, file: p.file });
    }
  }
  return out;
};

/**
 * Best-effort Zod → JSON Schema conversion. Returns either a schema or
 * an error string; never throws.
 */
export function toJsonSchemaSafe(
  zod: unknown
): { schema: unknown; error?: undefined } | { error: string } {
  if (!zod || typeof zod !== "object") {
    return { error: "no zod schema captured" };
  }
  try {
    const schema = z.toJSONSchema(zod as z.ZodType);
    return { schema };
  } catch (err) {
    /* c8 ignore next — the `String(err)` arm only fires when something
       non-Error is thrown, which Zod never does in practice. */
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatJsonSchema(idx: ContractIndex): string {
  const m = idx.model;
  const events: Record<string, EventReport> = {};

  for (const st of m.states) {
    for (const ev of st.events) {
      const status = eventStatus(ev.name, idx.allEventNames);
      const conv = toJsonSchemaSafe(ev.zod);
      const report: EventReport = {
        name: ev.name,
        file: st.file,
        line: ev.line,
        status: status.status,
        supersededBy: status.supersededBy,
        schemaText: ev.schema,
        producers: findProducers(m, ev.name),
        consumers: findConsumers(m, ev.name),
      };
      if ("schema" in conv) report.schema = conv.schema;
      else report.schemaError = conv.error;
      events[ev.name] = report;
    }
  }

  const out: Report = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    generator: "act-diagram/act-contracts",
    generatedAt: new Date().toISOString(),
    counts: {
      states: m.states.length,
      slices: m.slices.length,
      projections: m.projections.length,
      events: idx.allEventNames.size,
    },
    events,
  };
  return JSON.stringify(out, null, 2);
}
