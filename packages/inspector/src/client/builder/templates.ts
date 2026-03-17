export type Template = {
  name: string;
  description: string;
  code: string;
};

export const templates: Template[] = [
  {
    name: "Calculator",
    description:
      "Real calculator from packages/calculator — state machine with events, patches, and invariants",
    code: `import { state, ZodEmpty } from "@rotorsoft/act";
import type { Patch } from "@rotorsoft/act-patch";
import { z } from "zod";

export const DIGITS = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
] as const;
export const OPERATORS = ["+", "-", "*", "/"] as const;
export const SYMBOLS = [".", "="] as const;
export const KEYS = [...DIGITS, ...OPERATORS, ...SYMBOLS] as const;

export type Digits = (typeof DIGITS)[number];
export type Operators = (typeof OPERATORS)[number];
export type Keys = (typeof KEYS)[number];

const Events = {
  DigitPressed: z.object({ digit: z.enum(DIGITS) }),
  OperatorPressed: z.object({ operator: z.enum(OPERATORS) }),
  DotPressed: ZodEmpty,
  EqualsPressed: ZodEmpty,
  Cleared: ZodEmpty,
};

const Actions = {
  PressKey: z.object({ key: z.enum(KEYS) }),
  Clear: ZodEmpty,
};

const State = z.object({
  left: z.string().optional(),
  right: z.string().optional(),
  operator: z.enum(OPERATORS).optional(),
  result: z.number(),
});

const round = (n: number): number => Math.round(n * 100) / 100;
const Operations = {
  ["+"]: (l: number, r: number): number => round(l + r),
  ["-"]: (l: number, r: number): number => round(l - r),
  ["*"]: (l: number, r: number): number => round(l * r),
  ["/"]: (l: number, r: number): number => round(l / r),
};

const append = (
  { operator, left, right }: Readonly<Patch<z.infer<typeof State>>>,
  key: Digits | "."
) =>
  operator
    ? { right: (right || "").concat(key) }
    : { left: (left || "").concat(key) };

const compute = (
  { operator, left, right }: Readonly<Patch<z.infer<typeof State>>>,
  new_op?: Operators
) => {
  if (operator && left && right) {
    const result = Operations[operator](
      Number.parseFloat(left),
      Number.parseFloat(right)
    );
    return {
      result,
      left: result.toString(),
      operator: new_op,
      right: undefined,
    };
  }
  return new_op === "-" && !left ? { left: "-" } : { operator: new_op };
};

const Calculator = state({ Calculator: State })
  .init(() => ({ result: 0 }))
  .emits(Events)
  .patch({
    DigitPressed: ({ data }, state) => append(state, data.digit),
    OperatorPressed: ({ data }, state) => compute(state, data.operator),
    DotPressed: (_, state) => {
      const current = state.operator ? state.right || "" : state.left || "";
      if (current.includes(".")) return {};
      return append(state, ".");
    },
    EqualsPressed: (_, state) => compute(state),
    Cleared: () => ({
      result: 0,
      left: undefined,
      right: undefined,
      operator: undefined,
    }),
  })
  .on({ PressKey: Actions.PressKey })
  .emit(({ key }, { state }) => {
    if (key === ".") return ["DotPressed", {}];
    if (key === "=") {
      if (!state.operator) throw Error("no operator");
      return [["EqualsPressed", {}]];
    }
    return DIGITS.includes(key as Digits)
      ? ["DigitPressed", { digit: key as Digits }]
      : ["OperatorPressed", { operator: key as Operators }];
  })
  .on({ Clear: Actions.Clear })
  .given([
    {
      description: "Must be dirty",
      valid: (state) =>
        !!state.left || !!state.right || !!state.result || !!state.operator,
    },
  ])
  .emit(() => ["Cleared", {}])
  .snap((s) => s.patches > 12)
  .build();

export { Calculator };
`,
  },
  {
    name: "Ticket System",
    description:
      "Simplified WolfDesk — ticket lifecycle with slices, reactions, projections, and invariants",
    code: `import { state, slice, projection, type Invariant } from "@rotorsoft/act";
import { z } from "zod";

// --- Invariants ---

const mustBeOpen: Invariant<{ status: string }> = {
  description: "Ticket must be open",
  valid: (state) => state.status === "open",
};

// --- Ticket State (creation) ---

const TicketCreation = state({ Ticket: z.object({
  title: z.string(),
  userId: z.string(),
  status: z.string(),
  priority: z.string(),
})})
  .init(() => ({ title: "", userId: "", status: "new", priority: "low" }))
  .emits({
    TicketOpened: z.object({
      title: z.string(),
      userId: z.string(),
      priority: z.string(),
    }),
    TicketClosed: z.object({ closedById: z.string() }),
    TicketResolved: z.object({ resolvedById: z.string() }),
  })
  .patch({
    TicketOpened: ({ data }) => ({
      title: data.title,
      userId: data.userId,
      status: "open",
      priority: data.priority,
    }),
    TicketClosed: () => ({ status: "closed" }),
    TicketResolved: () => ({ status: "resolved" }),
  })
  .on({ OpenTicket: z.object({ title: z.string(), priority: z.string() }) })
    .emit((data, _, { actor }) => ["TicketOpened", { ...data, userId: actor.id }])
  .on({ CloseTicket: z.object({}) })
    .given([mustBeOpen])
    .emit((_, __, { actor }) => ["TicketClosed", { closedById: actor.id }])
  .on({ ResolveTicket: z.object({}) })
    .given([mustBeOpen])
    .emit((_, __, { actor }) => ["TicketResolved", { resolvedById: actor.id }])
  .build();

// --- Ticket State (operations) ---

const TicketOperations = state({ Ticket: z.object({
  assignedTo: z.string(),
  escalatedTo: z.string(),
})})
  .init(() => ({ assignedTo: "", escalatedTo: "" }))
  .emits({
    TicketAssigned: z.object({ agentId: z.string() }),
    TicketEscalated: z.object({ to: z.string(), reason: z.string() }),
  })
  .patch({
    TicketAssigned: ({ data }) => ({ assignedTo: data.agentId }),
    TicketEscalated: ({ data }) => ({ escalatedTo: data.to }),
  })
  .on({ AssignTicket: z.object({ agentId: z.string() }) })
    .emit("TicketAssigned")
  .on({ EscalateTicket: z.object({ to: z.string(), reason: z.string() }) })
    .emit("TicketEscalated")
  .build();

// --- Projection ---

const TicketProjection = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string(), userId: z.string(), priority: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("Ticket opened:", stream, data.title);
    })
  .on({ TicketClosed: z.object({ closedById: z.string() }) })
    .do(async ({ stream }) => {
      console.log("Ticket closed:", stream);
    })
  .build();

// --- Slice ---

const TicketCreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)
  .on("TicketOpened")
    .do(async function assign(event, _stream, app) {
      await app.do(
        "AssignTicket",
        { stream: event.stream, actor: { id: "system", name: "assign reaction" } },
        { agentId: "agent-1" },
        event
      );
    })
    .to((event) => ({ target: event.stream }))
  .build();

export { TicketCreation, TicketOperations, TicketProjection, TicketCreationSlice };
`,
  },
  {
    name: "Blank",
    description: "Empty starter template",
    code: `import { state } from "@rotorsoft/act";
import { z } from "zod";

// Define your state
const MyState = state({ MyState: z.object({
  // add fields here
})})
  .init(() => ({
    // initial values
  }))
  .emits({
    // MyEvent: z.object({ ... }),
  })
  .on({ /* MyAction: z.object({ ... }) */ })
    .emit("MyEvent")
  .build();

export { MyState };
`,
  },
];
