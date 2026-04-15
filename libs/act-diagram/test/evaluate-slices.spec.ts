import { describe, expect, it } from "vitest";
import { extractModel } from "../src/client/lib/evaluate.js";
import type { FileTab } from "../src/client/types/file-tab.js";

describe("extractModel — slices, reactions, projections", () => {
  it("extracts slices with reactions and projections", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";

export const Ticket = state({ Ticket: z.object({ status: z.string() }) })
  .init(() => ({ status: "new" }))
  .emits({
    TicketOpened: z.object({ title: z.string() }),
    TicketAssigned: z.object({ to: z.string() }),
  })
  .on({ OpenTicket: z.object({ title: z.string() }) })
    .emit("TicketOpened")
  .on({ AssignTicket: z.object({ to: z.string() }) })
    .emit("TicketAssigned")
  .build();
`,
      },
      {
        path: "src/proj.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";

export const TicketProj = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string() }) })
    .do()
  .build();
`,
      },
      {
        path: "src/slices.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { Ticket } from "./states.js";
import { TicketProj } from "./proj.js";

export const TicketSlice = slice()
  .withState(Ticket)
  .withProjection(TicketProj)
  .on("TicketOpened")
    .do(async function autoAssign(event, _stream, app) {
      await app.do("AssignTicket", event.stream, { to: "agent" }, event);
    })
    .to(() => "default")
  .build();
`,
      },
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { TicketSlice } from "./slices.js";
import { TicketProj } from "./proj.js";

export const app = act()
  .withSlice(TicketSlice)
  .withProjection(TicketProj)
  .on("TicketOpened")
    .do(async function logOpen() {})
    .to("log-target")
  .build();
`,
      },
    ];

    const { model, error } = extractModel(files);
    expect(error).toBeUndefined();
    expect(model.slices).toHaveLength(2);
    const ticketSlice = model.slices.find((s) => s.name === "TicketSlice")!;
    expect(ticketSlice.reactions).toHaveLength(1);
    expect(ticketSlice.reactions[0].dispatches).toContain("AssignTicket");
    expect(ticketSlice.projections).toContain("tickets");
    const globalSlice = model.slices.find((s) => s.name === "global")!;
    expect(globalSlice).toBeDefined();
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].path).toBe("src/app.ts");
    expect(model.entries[0].projections).toHaveLength(1);
    expect(model.reactions).toHaveLength(1);
    expect(model.reactions[0].handlerName).toBe("logOpen");
    expect(model.orchestrator).toBeDefined();
  });

  it("slice varName tagging skips acts from other files", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
      {
        path: "src/slices.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { S } from "./states.js";
export const MySlice = slice().withState(S).build();
`,
      },
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { MySlice } from "./slices.js";
export const app = act().withSlice(MySlice).build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.slices).toHaveLength(1);
    expect(model.slices[0].name).toBe("MySlice");
  });

  it("fixes up reaction handler names from source when mock yields 'on EventName'", () => {
    const files: FileTab[] = [
      {
        path: "domain/src/index.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ Created: z.object({}) })
  .on({ create: z.object({}) }).emit("Created")
  .build();
`,
      },
      {
        path: "app/src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { S } from "@org/domain";
import { onCreated } from "unresolvable-external-package";
export const app = act()
  .withState(S)
  .on("Created").do(onCreated).to("items")
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model.reactions).toHaveLength(1);
    // handler.name on proxy isn't a string -> falls back to "on Created"
    // fixupReactions recovers "onCreated" from source
    expect(model.reactions[0].handlerName).toBe("onCreated");
  });

  it("projection fallback scan skips already-captured projections", () => {
    const files: FileTab[] = [
      {
        path: "src/proj.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";
export const P = projection("items")
  .on({ ItemCreated: z.object({}) }).do()
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Mock eval captures it, fallback scan should not duplicate
    expect(model.projections).toHaveLength(1);
  });

  it("broken projection file produces no projections in act entry", () => {
    const files: FileTab[] = [
      {
        path: "src/proj.ts",
        content: `
import { projection } from "@rotorsoft/act";
import { z } from "zod";
const x = ({{ broken }});
export const GameProjection = projection("games")
  .on({ GameCreated: z.object({}) }).do()
  .build();
`,
      },
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const Game = state({ Game: z.object({}) })
  .init(() => ({}))
  .emits({ GameCreated: z.object({}) })
  .on({ CreateGame: z.object({}) }).emit("GameCreated")
  .build();
`,
      },
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { Game } from "./states.js";
import { GameProjection } from "./proj.js";
export const app = act()
  .withState(Game)
  .withProjection(GameProjection)
  .build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Broken projection file produces no projections
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].projections).toHaveLength(0);
  });

  it("act._sourceFile skip in slice varName tagging (line 189)", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({}))
  .emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E")
  .build();
`,
      },
      {
        path: "src/slices.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { S } from "./states.js";
export const MySlice = slice().withState(S).build();
`,
      },
      {
        path: "src/act1.ts",
        content: `
import { act } from "@rotorsoft/act";
import { MySlice } from "./slices.js";
export const app1 = act().withSlice(MySlice).build();
`,
      },
      {
        path: "src/act2.ts",
        content: `
import { act } from "@rotorsoft/act";
import { MySlice } from "./slices.js";
export const app2 = act().withSlice(MySlice).build();
`,
      },
    ];
    const { model } = extractModel(files);
    // Both acts should have built
    expect(model.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("duplicate .withSlice() in same file (line 149 false branch)", () => {
    const files: FileTab[] = [
      {
        path: "src/states.ts",
        content: `
import { state } from "@rotorsoft/act";
import { z } from "zod";
export const S = state({ S: z.object({}) })
  .init(() => ({})).emits({ E: z.object({}) })
  .on({ a: z.object({}) }).emit("E").build();
`,
      },
      {
        path: "src/slices.ts",
        content: `
import { slice } from "@rotorsoft/act";
import { S } from "./states.js";
export const MySlice = slice().withState(S).build();
`,
      },
      {
        path: "src/app.ts",
        content: `
import { act } from "@rotorsoft/act";
import { MySlice } from "./slices.js";
export const app = act().withSlice(MySlice).withSlice(MySlice).build();
`,
      },
    ];
    const { model } = extractModel(files);
    expect(model).toBeDefined();
  });
});
