// Sample: archive Ticket streams to S3 as JSONL before the online close cycle
// truncates them.
//
// This file is illustrative, not a runtime dependency of @rotorsoft/act. The
// `@aws-sdk/client-s3` import below is NOT declared in any package.json in this
// repo — copy this file into your own service and add the dep yourself:
//
//   pnpm add @aws-sdk/client-s3
//
// How the cycle calls .archives():
//   1. The .autocloses({...}) predicate matches a stream (head event is
//      TicketResolved and at least 90 days old).
//   2. The framework commits a tombstone marker on the stream — guard window
//      opens, no new writes can land.
//   3. The framework awaits this archiver function. We read history and ship
//      it to S3.
//   4. On resolve: framework calls Store.truncate() — events are gone from
//      the hot table, S3 has the cold copy.
//   5. On throw: framework leaves the stream guarded and un-truncated; the
//      cycle retries the candidate on the next tick.
//
// Idempotency: the S3 key is derived from the stream name with no timestamp,
// so a retry overwrites the previous (incomplete) upload.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { state, store } from "@rotorsoft/act";
import { z } from "zod";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET ?? "act-archive";

// Domain shape — a minimal Ticket state.

const TicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "resolved"]),
});

const TicketOpened = z.object({
  id: z.string(),
  title: z.string(),
});

const TicketResolved = z.object({
  id: z.string(),
  resolution: z.string(),
});

export const Ticket = state({ Ticket: TicketSchema })
  .init(() => ({ id: "", title: "", status: "open" as const }))
  .emits({ TicketOpened, TicketResolved })
  .patch({
    TicketOpened: ({ data }) => ({
      id: data.id,
      title: data.title,
      status: "open",
    }),
    TicketResolved: (_e, state) => ({ ...state, status: "resolved" }),
  })
  .on({ openTicket: z.object({ id: z.string(), title: z.string() }) })
  .emit((action) => ["TicketOpened", action])
  .on({
    resolveTicket: z.object({ id: z.string(), resolution: z.string() }),
  })
  .emit((action) => ["TicketResolved", action])
  // Close 90 days after the ticket is resolved.
  .autocloses({
    is: "TicketResolved",
    after: { days: 90 },
  })
  // Archive the stream's events to S3 before truncate.
  .archives(async (stream) => {
    // Walk the stream history in version order.
    const events: unknown[] = [];
    await store().query(
      (event) => {
        events.push(event);
      },
      { stream }
    );

    // Serialize as JSONL — one event per line.
    const body = events.map((e) => JSON.stringify(e)).join("\n");

    // Upload. The key is stable across retries; a re-run after a previous
    // tick's failure overwrites the same object cleanly. Throwing from
    // s3.send() bubbles to the cycle, which leaves the stream un-truncated
    // and re-queues it for the next tick — no data loss on a transient
    // S3 error.
    await s3.send(
      new PutObjectCommand({
        Bucket: ARCHIVE_BUCKET,
        Key: `tickets/${stream}.jsonl`,
        Body: body,
        ContentType: "application/x-ndjson",
      })
    );
  })
  .build();
