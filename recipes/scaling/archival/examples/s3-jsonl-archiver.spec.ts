import { dispose, store } from "@rotorsoft/act";
import { afterAll, describe, expect, it, vi } from "vitest";
import { archiveStreamToS3 } from "./s3-jsonl-archiver.js";

const sent = vi.hoisted(() => [] as { Key: string; Body: string }[]);

vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class {
    constructor(input: { Key: string; Body: string }) {
      sent.push(input);
    }
  },
  S3Client: class {
    async send() {}
  },
}));

describe("archiving a stream to S3", () => {
  afterAll(async () => {
    await dispose()();
  });

  it("writes only that stream, without what forget must erase", async () => {
    const meta = { correlation: "", causation: {} };
    const event = {
      name: "Booked",
      data: { who: "ann" },
      pii: { email: "ann@x.io" },
    };
    await store().commit([{ stream: "room-1", msgs: [event] }], meta);
    await store().commit([{ stream: "room-10", msgs: [event] }], meta);

    await archiveStreamToS3("room-1", { id: 7 });

    const lines = sent[0].Body.split("\n").map((line) => JSON.parse(line));
    expect(lines.map((e) => e.stream)).toEqual(["room-1"]);
    expect(sent[0].Body).not.toContain("ann@x.io");
  });

  it("keeps the copy of an earlier prune when the stream is archived again", async () => {
    sent.length = 0;
    await archiveStreamToS3("room-1", { id: 7 });
    await archiveStreamToS3("room-1", { id: 7 });
    await archiveStreamToS3("room-1", { id: 9 });
    expect(sent.map((p) => p.Key)).toEqual([
      "room-1-7.jsonl",
      "room-1-7.jsonl",
      "room-1-9.jsonl",
    ]);
  });
});
