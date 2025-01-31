import { dispose, InvariantError } from "@rotorsoft/act";
import { Chance } from "chance";
import {
  MessageNotFoundError,
  TicketCannotOpenTwiceError,
} from "../../src/wolfdesk/errors";
import {
  acknowledgeMessage,
  addMessage,
  assignTicket,
  closeTicket,
  escalateTicket,
  markMessageDelivered,
  markTicketResolved,
  openTicket,
  reassignTicket,
  requestTicketEscalation,
  target,
} from "./actions";

const chance = new Chance();

describe("ticket invariants", () => {
  afterAll(async () => {
    await dispose()();
  });

  it("should throw when trying to open twice", async () => {
    const t = target();
    await openTicket(t, "opening once", "the first opening");
    await expect(
      openTicket(t, "opening twice", "the second opening")
    ).rejects.toThrow(TicketCannotOpenTwiceError);
  });

  it("should throw when trying to close twice or empty", async () => {
    const t = target();
    await expect(closeTicket(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(closeTicket(t)).rejects.toThrow(InvariantError);
  });

  it("should throw when assigning agent to empty or closed ticket", async () => {
    const t = target();
    await expect(assignTicket(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(assignTicket(t)).rejects.toThrow(InvariantError);
  });

  it("should throw when adding message to empty or closed ticket", async () => {
    const t = target();
    await expect(addMessage(t, "message")).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(addMessage(t, "message")).rejects.toThrow(InvariantError);
  });

  it("should throw when requesting escalation to empty or closed ticket", async () => {
    const t = target();
    await expect(requestTicketEscalation(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(requestTicketEscalation(t)).rejects.toThrow(InvariantError);
  });

  it("should throw when escalating empty or closed ticket", async () => {
    const t = target();
    await expect(escalateTicket(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(escalateTicket(t)).rejects.toThrow(InvariantError);
  });

  it("should throw when reassigning empty or closed ticket", async () => {
    const t = target();
    await expect(reassignTicket(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(reassignTicket(t)).rejects.toThrow(InvariantError);
  });

  it("should throw when marking messages delivered on empty or closed or invalid ticket", async () => {
    const t = target();
    await expect(markMessageDelivered(t, chance.guid())).rejects.toThrow(
      InvariantError
    );
    await openTicket(t, "opening once", "the first opening");
    await expect(markMessageDelivered(t, chance.guid())).rejects.toThrow(
      MessageNotFoundError
    );
    await closeTicket(t);
    await expect(markMessageDelivered(t, chance.guid())).rejects.toThrow(
      InvariantError
    );
  });

  it("should throw when marking message read on empty or closed or invalid ticket", async () => {
    const t = target();
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toThrow(
      InvariantError
    );
    await openTicket(t, "opening once", "the first opening");
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toThrow(
      MessageNotFoundError
    );
    await closeTicket(t);
    await expect(acknowledgeMessage(t, chance.guid())).rejects.toThrow(
      InvariantError
    );
  });

  it("should throw when resolving empty or closed ticket", async () => {
    const t = target();
    await expect(markTicketResolved(t)).rejects.toThrow(InvariantError);
    await openTicket(t, "opening once", "the first opening");
    await closeTicket(t);
    await expect(markTicketResolved(t)).rejects.toThrow(InvariantError);
  });
});
