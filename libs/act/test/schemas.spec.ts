import { z } from "zod";
import { buildSnapshotSchema, validate } from "../src";

const A = {
  state: z.object({ a: z.string(), b: z.number().int().min(0).max(100) }),
  actions: {
    Action: z.object({
      a: z.string(),
      b: z.number().nullish(),
    }),
  },
  events: {
    Event: z.object({
      a: z.date(),
      b: z.boolean().optional(),
    }),
  },
} as const;

const expectedSnapshot = {
  state: {
    a: "a",
    b: 0,
  },
  patches: 0,
  snaps: 0,
  event: {
    name: "Event",
    data: {
      a: new Date(),
      b: undefined,
    },
    id: 0,
    stream: "stream",
    version: 0,
    created: new Date(),
    meta: {
      correlation: "abc",
      causation: {
        action: {
          name: "Action",
          stream: "stream",
          actor: { id: "1", name: "Actor" },
        },
      },
    },
  },
};

describe("Schemas", () => {
  it("should validate snapshot schema", () => {
    const schema = buildSnapshotSchema(A);
    const valid = validate("snapshot", expectedSnapshot, schema);
    expect(valid).toMatchObject(expectedSnapshot);
  });
});
