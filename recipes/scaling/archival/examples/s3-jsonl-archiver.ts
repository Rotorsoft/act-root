// Sample: archive a stream to S3 as JSONL before the online close cycle
// truncates (or trims) it. The archiver is model-agnostic — it queries a
// stream's events by name, so it works for any state. Wire it to the
// canonical wolfdesk Ticket (or your own state) via `.archives(...)`:
//
//   // packages/wolfdesk/src/ticket-creation.ts
//   export const TicketCreation = state({ Ticket: TicketCreationState })
//     // ...emits / patch / on / emit...
//     .autocloses({ is: ["TicketClosed", "TicketResolved"], after: { days: 90 } })
//     .archives(archiveStreamToS3)   // <- this function
//     .build();
//
// How the cycle calls `.archives(stream)`:
//   1. The `.autocloses({...})` predicate matches a stream (terminal + aged).
//   2. The framework commits a tombstone marker — guard window opens, no new
//      writes can land.
//   3. The framework awaits this archiver. We read history and ship it to S3.
//   4. On resolve: `Store.truncate()` — events leave the hot table, S3 has the
//      cold copy. On throw: the stream stays guarded + un-truncated (no data
//      loss); resume it with `app.close([{ stream }])` once S3 is back.
//
// The `@aws-sdk/client-s3` dep is dev-only here; copy this into your own
// service and add it there.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { store } from "@rotorsoft/act";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET ?? "act-archive";

/**
 * Archive every event on `stream` to S3 as JSONL, one event per line.
 * The S3 key holds the stream name and the head it was read at, so a retry
 * overwrites the same object (idempotent), and a later prune or close of the same
 * stream, which reads only what's left, doesn't overwrite an earlier copy.
 */
export async function archiveStreamToS3(
  stream: string,
  head: { id: number }
): Promise<void> {
  const events: unknown[] = [];
  await store().query(
    (event) => {
      events.push(event);
    },
    // `stream` alone is a pattern: `room-1` would also read `room-10`. And
    // what `app.forget` erases must never reach cold storage.
    { stream, stream_exact: true, with_pii: false }
  );

  const body = events.map((e) => JSON.stringify(e)).join("\n");

  await s3.send(
    new PutObjectCommand({
      Bucket: ARCHIVE_BUCKET,
      Key: `${stream}-${head.id}.jsonl`,
      Body: body,
      ContentType: "application/x-ndjson",
    })
  );
}
