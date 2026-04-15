import type { FileTab } from "../types/file-tab.js";

/** Sample Act app files for visual testing of the diagram */
export const SAMPLE_FILES: FileTab[] = [
  {
    path: "src/states.ts",
    content: `import { state } from "@rotorsoft/act";
import { z } from "zod";

const mustBeOpen = {
  description: "Ticket must be open",
  valid: (state: any) => state.status === "open",
};

export const TicketCreation = state({ TicketCreation: z.object({
  title: z.string(),
  description: z.string(),
  status: z.string(),
  assignedTo: z.string(),
}) })
  .init(() => ({ title: "", description: "", status: "new", assignedTo: "" }))
  .emits({
    TicketOpened: z.object({ title: z.string(), description: z.string() }),
    TicketAssigned: z.object({ assignedTo: z.string() }),
  })
  .on({ OpenTicket: z.object({ title: z.string(), description: z.string() }) })
    .emit("TicketOpened")
  .on({ AssignTicket: z.object({ assignedTo: z.string() }) })
    .emit("TicketAssigned")
  .build();

export const TicketOperations = state({ TicketOperations: z.object({
  status: z.string(),
  resolution: z.string(),
}) })
  .init(() => ({ status: "open", resolution: "" }))
  .emits({
    TicketClosed: z.object({ resolution: z.string() }),
    TicketReopened: z.object({}),
    TicketEscalated: z.object({ reason: z.string() }),
  })
  .patch({
    TicketClosed: ({ data }, state) => ({ ...state, status: "closed", resolution: data.resolution }),
    TicketReopened: (_, state) => ({ ...state, status: "open" }),
    TicketEscalated: (_, state) => ({ ...state, status: "escalated" }),
  })
  .on({ CloseTicket: z.object({ resolution: z.string() }) })
    .given([mustBeOpen])
    .emit("TicketClosed")
  .on({ ReopenTicket: z.object({}) })
    .emit("TicketReopened")
  .on({ EscalateTicket: z.object({ reason: z.string() }) })
    .given([mustBeOpen])
    .emit("TicketEscalated")
  .build();`,
  },
  {
    path: "src/projection.ts",
    content: `import { projection } from "@rotorsoft/act";
import { z } from "zod";

export const TicketProjection = projection("tickets")
  .on({ TicketOpened: z.object({ title: z.string(), description: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("projecting", stream, data);
    })
  .on({ TicketClosed: z.object({ resolution: z.string() }) })
    .do(async ({ stream, data }) => {
      console.log("projecting close", stream, data);
    })
  .build();`,
  },
  {
    path: "src/slices.ts",
    content: `import { slice } from "@rotorsoft/act";
import { TicketCreation, TicketOperations } from "./states.js";
import { TicketProjection } from "./projection.js";

export const CreationSlice = slice()
  .withState(TicketCreation)
  .withState(TicketOperations)
  .withProjection(TicketProjection)
  .on("TicketOpened")
    .do(async function autoAssign(event, _stream, app) {
      await app.do("AssignTicket", event.stream, { assignedTo: "default-agent" }, event);
    })
    .to(() => "default")
  .on("TicketEscalated")
    .do(async function notifyManager(event, _stream, _app) {
      console.log("Escalation:", event.data);
    })
    .to("notifications")
  .build();`,
  },
  {
    path: "src/app.ts",
    content: `import { act } from "@rotorsoft/act";
import { CreationSlice } from "./slices.js";

export const app = act()
  .withSlice(CreationSlice)
  .build();`,
  },
];
