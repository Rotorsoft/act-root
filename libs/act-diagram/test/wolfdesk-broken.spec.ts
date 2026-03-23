import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { extractModel } from "../src/client/lib/evaluate.js";

describe("wolfdesk broken import", () => {
  const wolfdesk = join(__dirname, "../../../packages/wolfdesk/src");
  const readFile = (name: string) => ({
    path: `src/${name}`,
    content: readFileSync(join(wolfdesk, name), "utf-8"),
  });

  const baseFiles = () => [
    readFile("schemas/ticket.schemas.ts"),
    readFile("errors.ts"),
    readFile("services/agent.ts"),
    readFile("services/notification.ts"),
    readFile("ticket-invariants.ts"),
    readFile("ticket-creation.ts"),
    readFile("ticket-messaging.ts"),
    readFile("ticket-projections.ts"),
    readFile("ticket.ts"),
    readFile("bootstrap.ts"),
  ];

  it("break: rename TicketAssigned in emits shorthand (ReferenceError)", () => {
    // Change line 25: TicketAssigned, → xTicketAssigned,
    // This is an undeclared variable → ReferenceError in strict mode
    const opsContent = readFileSync(
      join(wolfdesk, "ticket-operations.ts"),
      "utf-8"
    );
    const broken = opsContent.replace(
      /\.emits\(\{[\s\S]*?TicketAssigned,/m,
      (match) => match.replace("TicketAssigned,", "xTicketAssigned,")
    );

    const files = [
      ...baseFiles(),
      { path: "src/ticket-operations.ts", content: broken },
    ];

    const { model } = extractModel(files);

    const ops = model.slices.find((s) => s.name === "TicketOpsSlice");
    const creation = model.slices.find((s) => s.name === "TicketCreationSlice");
    const messaging = model.slices.find(
      (s) => s.name === "TicketMessagingSlice"
    );

    console.log(
      "ops:",
      ops?.name,
      "states:",
      ops?.states.length,
      "error:",
      ops?.error
    );
    console.log(
      "creation:",
      creation?.name,
      "states:",
      creation?.states.length,
      "error:",
      creation?.error
    );
    console.log(
      "messaging:",
      messaging?.name,
      "states:",
      messaging?.states.length,
      "error:",
      messaging?.error
    );

    // All 3 slices visible
    expect(ops).toBeDefined();
    expect(creation).toBeDefined();
    expect(messaging).toBeDefined();

    // Ops has error
    expect(ops!.error).toBeDefined();
  });

  it("break: rename TicketAssigned in import (undefined value)", () => {
    // Change import line: TicketAssigned → xTicketAssigned
    // The .emits({ TicketAssigned, ... }) still compiles but TicketAssigned is undefined
    const opsContent = readFileSync(
      join(wolfdesk, "ticket-operations.ts"),
      "utf-8"
    );
    const broken = opsContent.replace(
      /import \{[\s\S]*?\} from "\.\/schemas/m,
      (match) => match.replace("TicketAssigned,\n", "xTicketAssigned,\n")
    );

    const files = [
      ...baseFiles(),
      { path: "src/ticket-operations.ts", content: broken },
    ];

    const { model } = extractModel(files);

    const ops = model.slices.find((s) => s.name === "TicketOpsSlice");
    const creation = model.slices.find((s) => s.name === "TicketCreationSlice");
    const messaging = model.slices.find(
      (s) => s.name === "TicketMessagingSlice"
    );

    console.log(
      "ops:",
      ops?.name,
      "states:",
      ops?.states.length,
      "error:",
      ops?.error
    );
    console.log(
      "creation:",
      creation?.name,
      "states:",
      creation?.states.length,
      "error:",
      creation?.error
    );
    console.log(
      "messaging:",
      messaging?.name,
      "states:",
      messaging?.states.length,
      "error:",
      messaging?.error
    );

    // All 3 slices visible
    expect(ops).toBeDefined();
    expect(creation).toBeDefined();
    expect(messaging).toBeDefined();

    // Ops has error (undefined schema detected by validation)
    expect(ops!.error).toBeDefined();
  });
});
