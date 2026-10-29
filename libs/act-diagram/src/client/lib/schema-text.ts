/**
 * Readable text for the runtime Zod schemas the parser captures, for the
 * flow animation's popups: fields one per line in a TypeScript-like shape,
 * with the constraints a reader cares about (`integer ≥ 1`), and the
 * messages of the schema's refinements, which are a state's invariants.
 */
import { z } from "zod";

type Json = {
  type?: string | string[];
  properties?: Record<string, Json>;
  required?: string[];
  additionalProperties?: boolean | Json;
  items?: Json;
  prefixItems?: Json[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Json[];
  oneOf?: Json[];
  allOf?: Json[];
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

/** Zod's integer bounds: implied by `.int()`, so not worth printing. */
const SAFE = Number.MAX_SAFE_INTEGER;

function to_json(zod: unknown): Json | undefined {
  if (!zod || typeof zod !== "object") return undefined;
  try {
    return z.toJSONSchema(zod as z.ZodType, {
      unrepresentable: "any",
      // a date has no JSON Schema type; name it instead of printing `unknown`
      override: (ctx) => {
        if ((ctx.zodSchema as any)._zod.def.type === "date")
          ctx.jsonSchema.format = "date";
      },
    }) as Json;
  } catch {
    return undefined;
  }
}

function bounds(s: Json): string {
  const out: string[] = [];
  if (s.minimum !== undefined && s.minimum !== -SAFE)
    out.push(`≥ ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined && s.maximum !== SAFE) out.push(`≤ ${s.maximum}`);
  if (s.exclusiveMaximum !== undefined) out.push(`< ${s.exclusiveMaximum}`);
  const len = (lo?: number, hi?: number, unit = "") => {
    if (lo !== undefined && lo === hi) return out.push(`${lo}${unit}`);
    if (lo !== undefined) out.push(`≥ ${lo}${unit}`);
    if (hi !== undefined) out.push(`≤ ${hi}${unit}`);
  };
  len(s.minLength, s.maxLength, " chars");
  len(s.minItems, s.maxItems, " items");
  return out.length ? ` ${out.join(", ")}` : "";
}

function type_text(s: Json, pad: string): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map((u) => type_text(u, pad)).join(" | ");
  if (s.allOf) return s.allOf.map((u) => type_text(u, pad)).join(" & ");
  if (s.format) return `${s.format}${bounds(s)}`;
  const type = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (type === "array") {
    if (s.prefixItems)
      return `[${s.prefixItems.map((u) => type_text(u, pad)).join(", ")}]`;
    return `${wrap(type_text(s.items as Json, pad))}[]${bounds(s)}`;
  }
  if (type === "object") {
    if (s.properties) return object_text(s, pad);
    // a record: the value schema, or `{}` (unknown) when it's `true`
    return `Record<string, ${type_text({ ...(s.additionalProperties as Json) }, pad)}>`;
  }
  return `${type ?? "unknown"}${bounds(s)}`;
}

/** Parenthesizes a union before `[]`, so `("a" | "b")[]` reads right. */
const wrap = (t: string) => (t.includes(" | ") ? `(${t})` : t);

function object_text(s: Json, pad: string): string {
  const inner = `${pad}  `;
  const required = new Set(s.required ?? []);
  const lines = Object.entries(s.properties as Record<string, Json>).map(
    ([k, v]) =>
      `${inner}${k}${required.has(k) ? "" : "?"}: ${type_text(v, inner)}`
  );
  return lines.length ? `{\n${lines.join("\n")}\n${pad}}` : "{}";
}

/**
 * The fields of one schema, or of several merged (the partial states that
 * share a name), one per line. Undefined when nothing could be read.
 */
export function schema_text(zod: unknown | unknown[]): string | undefined {
  const all = (Array.isArray(zod) ? zod : [zod])
    .map(to_json)
    .filter((s): s is Json => !!s);
  if (!all.length) return undefined;
  if (all.length === 1 && all[0].type !== "object")
    return type_text(all[0], "");
  // a field declared by several partials keeps the first declaration
  const properties: Record<string, Json> = {};
  for (const s of all)
    for (const [k, v] of Object.entries(s.properties ?? {}))
      properties[k] ??= v;
  if (!Object.keys(properties).length) return "{}";
  const merged: Json = {
    type: "object",
    properties,
    required: all.flatMap((s) => s.required ?? []),
  };
  const text = object_text(merged, "");
  return text.slice(2, -2).replace(/^ {2}/gm, "");
}

/**
 * The messages of a schema's refinements (`.refine(fn, "message")`),
 * nested ones included, in declaration order and without repeats. A
 * refinement with no message can't be named, so it's left out.
 */
export function schema_rules(zod: unknown | unknown[]): string[] {
  const out = new Set<string>();
  const visit = (node: any) => {
    const def = node?._zod?.def;
    if (!def) return;
    for (const check of def.checks ?? []) {
      const cdef = check._zod.def;
      if (cdef.check !== "custom") continue;
      const message = cdef.error?.();
      if (typeof message === "string") out.add(message);
    }
    for (const child of Object.values(def.shape ?? {})) visit(child);
    visit(def.innerType);
    visit(def.element);
    visit(def.valueType);
    visit(def.left);
    visit(def.right);
    for (const option of def.options ?? []) visit(option);
  };
  for (const z of Array.isArray(zod) ? zod : [zod]) visit(z);
  return [...out];
}
