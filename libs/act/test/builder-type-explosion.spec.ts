/**
 * Type-narrowing regressions for the state and projection builders.
 *
 * Companion to the `.emit()` overload split: the prior `handler | string`
 * union signature confused contextual typing on the function alternative,
 * letting `TState` collapse to its `Schema` constraint inside the callback
 * (so destructured snapshot fields lost their types). Splitting `.emit()`
 * into two overloads — function and string — lets TS pick the matching
 * branch eagerly and keeps callback parameter narrowing sharp.
 *
 * The runtime expectations are minor; the value of the file is that it
 * MUST type-check and that the `@ts-expect-error` directives stay USED
 * (proving narrowing is real and didn't collapse to `any`).
 */
import { delta } from "@rotorsoft/act-patch";
import { z } from "zod";
import { projection, state } from "../src/index.js";
import type { Invariant } from "../src/types/index.js";

// Realistic-shaped Zod schemas: a TS enum fed through `z.enum(...)` plus
// ~10 fields with mixed required / optional / default modifiers. Smaller
// schemas don't reproduce the inference degradation even with the same
// chain shape, so the regression repro keeps the surface honest.
enum InvoiceSchedule {
  Weekly = "weekly",
  Biweekly = "biweekly",
  Semimonthly = "semimonthly",
  Monthly = "monthly",
}

const ClientFields = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  email: z.string().optional(),
  contactName: z.string().optional(),
  hourlyRate: z.number().positive(),
  paymentTermsDays: z.number().int().default(30),
  invoiceSchedule: z
    .enum(InvoiceSchedule)
    .optional()
    .default(InvoiceSchedule.Monthly),
  commuteMiles: z.number().optional(),
  paymentInstructions: z.string().optional(),
});

const ClientFieldsPatch = z.object({
  name: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  email: z.string().optional(),
  contactName: z.string().optional(),
  hourlyRate: z.number().positive().optional(),
  paymentTermsDays: z.number().int().optional(),
  invoiceSchedule: z.enum(InvoiceSchedule).optional(),
  commuteMiles: z.number().optional(),
  paymentInstructions: z.string().optional(),
});

const RegisterClient = ClientFields;
const UpdateClient = ClientFieldsPatch;
const ClientRegistered = ClientFields;
const ClientUpdated = ClientFieldsPatch;

const ClientState = z.object({
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  email: z.string().optional(),
  contactName: z.string().optional(),
  hourlyRate: z.number(),
  paymentTermsDays: z.number().int(),
  invoiceSchedule: z.enum(InvoiceSchedule),
  active: z.boolean(),
  commuteMiles: z.number().optional(),
  paymentInstructions: z.string().optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

describe("builder type narrowing regressions", () => {
  // ── Function-style .emit() preserves snapshot narrowing ────────────────
  // Under the prior `handler | string` union signature, TS could collapse
  // `snapshot.state` to `Readonly<Schema>` inside the callback, losing all
  // field types. With the overloads split, the function alternative is
  // picked eagerly and `s.field` stays narrowed.
  it(".emit((data, snap) => …) keeps snapshot.state narrowed", () => {
    const Client = state({ Client: ClientState })
      .init(() => ({
        slug: "",
        name: "",
        address: "",
        hourlyRate: 0,
        paymentTermsDays: 30,
        invoiceSchedule: InvoiceSchedule.Monthly,
        active: true,
      }))
      .emits({ ClientRegistered, ClientUpdated })
      .on({ RegisterClient })
      .emit("ClientRegistered")
      .on({ UpdateClient })
      .emit((data, { state: s }) => {
        const { active: _a, slug: _s, ...current } = s;
        // Narrowing proof: `current.name` must remain `string`, not `any`.
        const _name: string = current.name;
        const target = { ...current, ...data };
        const patch = delta(current, target);
        const evt: Partial<typeof current> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (v !== null) (evt as Record<string, unknown>)[k] = v;
        }
        return ["ClientUpdated", evt];
      })
      .build();

    expect(Client.on.RegisterClient).toBeDefined();
    expect(Client.on.UpdateClient).toBeDefined();
  });

  // ── Strong narrowing of snapshot.state — sample assertion fails ─────────
  // If `snapshot.state` ever widens to `any`/`Schema`, both the negative
  // assertion and the positive one will quietly succeed. Pair them so a
  // regression is caught either way.
  it(".emit() callback narrows snapshot.state to TState (not Schema)", () => {
    state({ Counter: z.object({ count: z.number(), label: z.string() }) })
      .init(() => ({ count: 0, label: "" }))
      .emits({ Bumped: z.object({ by: z.number() }) })
      .on({ bump: z.object({ by: z.number() }) })
      .emit((action, snap) => {
        const _count: number = snap.state.count;
        // @ts-expect-error label is string, not number
        const _bad: number = snap.state.label;
        return ["Bumped", { by: action.by + _count }];
      })
      .build();
    expect(true).toBe(true);
  });

  // ── String-form .emit("EventName") keeps autocomplete + rejection ──────
  it('.emit("EventName") rejects unknown event names', () => {
    state({ Counter: z.object({ count: z.number() }) })
      .init(() => ({ count: 0 }))
      .emits({ Incremented: z.object({ by: z.number() }) })
      .on({ inc: z.object({ by: z.number() }) })
      // @ts-expect-error 'NotAnEvent' isn't in .emits()
      .emit("NotAnEvent")
      .build();
    expect(true).toBe(true);
  });

  // ── Partial-state Invariant<{slug: string}> still accepted ─────────────
  // A common pattern: write an invariant against a tiny subset of state
  // (one field) and pass it where the full state is expected. This is
  // contravariantly safe and must continue to type-check.
  it(".given([Invariant<Subset>]) accepts narrower-than-state invariants", () => {
    const slugMustBeUnused: Invariant<{ slug: string }> = {
      description: "A client with this slug is already registered",
      valid: (s) => s.slug === "",
    };

    const Client = state({ Client: ClientState })
      .init(() => ({
        slug: "",
        name: "",
        address: "",
        hourlyRate: 0,
        paymentTermsDays: 30,
        invoiceSchedule: InvoiceSchedule.Monthly,
        active: true,
      }))
      .emits({ ClientRegistered, ClientUpdated })
      .patch({
        ClientRegistered: ({ data }) => ({
          ...data,
          slug: slugify(data.name),
          active: true,
        }),
        ClientUpdated: ({ data }) => ({ ...data }),
      })
      .on({ RegisterClient })
      .given([slugMustBeUnused])
      .emit("ClientRegistered")
      .build();

    expect(Client.given?.RegisterClient).toBeDefined();
  });

  // ── Projection chain over realistic schemas type-checks cleanly ────────
  // Multi-`.on().do()` over fat schemas was the canonical TS2589 trigger
  // when coupled with cross-version zod compares. Even with peer-deps
  // ensuring a single zod, this remains useful as a smoke test.
  it("projection: chained .on().do() over fat schemas type-checks", () => {
    const ClientsView = projection("clients_view")
      .on({ ClientRegistered })
      .do(async function registered({ stream, data }) {
        const _id: string = stream;
        const _name: string = data.name;
      })
      .on({ ClientUpdated })
      .do(async function updated({ stream, data }) {
        const _id: string = stream;
        // ClientUpdated.name is optional — narrowing must reflect that.
        const _maybeName: string | undefined = data.name;
      })
      .build();

    expect(ClientsView._tag).toBe("Projection");
    expect(ClientsView.events.ClientRegistered).toBeDefined();
    expect(ClientsView.events.ClientUpdated).toBeDefined();
  });
});
