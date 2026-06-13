# Archiving streams before truncate

Pair `.autocloses({...})` with `.archives(fn)` so the events of a closing stream land in cold storage — S3, an analytics warehouse, JSONL on a mounted disk — *before* the framework truncates them. The archiver runs inside the close cycle's guard window; if it throws, the stream stays guarded and un-truncated, and the cycle retries on the next tick. No partial state, no half-archived rows.

Default Act doesn't need this recipe. Most apps with a clean terminal event (`Resolved`, `Delivered`, `Cancelled`) can close streams cold and never look back — `app.load` on a closed stream throws `StreamClosedError`, and that's the right answer for the dominant workload. Reach for archival only when the operator answer to "what happens if someone asks for the closed events six months from now?" is not "they don't get them."

## When this recipe earns its keep

Three operator concerns drive the decision to archive before truncate:

- **Auditors want the events later.** A regulator, an internal audit team, or a future SOC 2 review needs to walk the original event log of a customer interaction the business has long since marked closed. The hot store doesn't need to serve that read; cold storage does.
- **Users might re-query closed streams.** A "view past tickets" screen that occasionally hits old streams is fine — the archive is the source of truth for the cold read, the hot store handles the live one.
- **Regulatory retention requires the bytes to exist somewhere.** Frameworks like GDPR, HIPAA, or sector-specific rules sometimes mandate retention for N months even after the operational lifecycle is over. The events must survive; the hot table doesn't have to.

If none of these apply, drop `.archives(...)` and let `.autocloses({...})` truncate clean. The framework charges nothing for the absent declarator.

## The contract

The `.archives(fn)` declarator is documented in [docs/docs/guides/close-policies.md § The archive contract](../../../docs/docs/guides/close-policies.md). The four invariants the cycle gives you, restated for operators:

1. **The archiver runs inside the guard window.** A tombstone marker has already been committed with `expectedVersion`, so no new writes can land on the stream while the archiver is running. The events you read are the final ones.
2. **A thrown archiver leaves the stream un-truncated.** The error propagates to the cycle's `closed`-emission path; no events are deleted, the stream stays guarded, and the cycle retries the candidate on the next tick. A network blip on the S3 PUT doesn't lose data — it pushes the close out by one cycle.
3. **The host owns idempotency.** A retry can call the archiver a second time on the same stream. Most archivers achieve idempotency by using the stream name as the destination key: `tickets/${stream}.jsonl` is the same key every retry, so the second PUT overwrites the first cleanly. If your destination is append-only (an analytics warehouse, a Kafka topic), put a dedup key in the payload.
4. **Resolve only when the data is durable.** The framework doesn't check whether S3 actually accepted the bytes. It only knows the archiver resolved. Don't ack from a queue ("I queued the write, the broker will handle it") and then return — the truncate will fire while the broker is still flushing. Wait for the storage backend to confirm, then resolve.

The archiver also holds the guard. A 10-second archiver delays the truncate by 10 seconds and adds 10 seconds to the cycle's flush. Keep it under a few hundred milliseconds where you can; stage the heavy work to a queue if it can't.

## The S3 + JSONL pattern

The shape that fits 80% of cases: dump each stream as one JSONL object per event, upload to S3 under a key derived from the stream name. The recipe walks four steps.

**Read stream history via `store().query`.** The store's `query(callback, filter)` method paginates events for the operator. Pass `{ stream }` to scope the read; the callback fires per event in version order. The archiver collects them into an array for serialization.

**Serialize to JSONL.** One JSON object per line, no wrapping array. JSONL is friendly to streaming readers, append-only consumers, and `jq -c` debugging. Keep the full `Committed` shape — `id`, `name`, `data`, `stream`, `version`, `created`, `meta` — so a future rehydrator has everything it needs.

**Upload with stable key naming.** `tickets/${stream}.jsonl` (or `audit/${stream}.jsonl`, etc.) — one key per stream. Retries on the same stream overwrite the same key, which is the cheap way to get idempotency. Don't include a timestamp in the key; that turns retries into duplicate uploads.

**Throw on AWS errors.** Catch nothing. If `s3.send(...)` rejects, let it bubble — the framework's safety property turns a thrown archiver into "leave the stream alone, retry next tick." Swallowing the error and resolving would silently truncate the stream with no archive in cold storage.

The sample at [examples/s3-jsonl-archiver.ts](examples/s3-jsonl-archiver.ts) is a working file an operator can copy into their service and adapt.

## Pair with `.autocloses({...})`

The two declarators live on the same state and run on the same cycle. Concrete shape:

```ts
import { state } from "@rotorsoft/act";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.ARCHIVE_BUCKET!;

const Ticket = state({ Ticket: ticketSchema })
  .init(() => defaults)
  .emits({ TicketOpened, TicketResolved })
  // ... actions, patches, invariants
  .autocloses({
    is: "TicketResolved",
    after: { days: 90 },
  })
  .archives(async (stream) => {
    const events: unknown[] = [];
    await store().query((e) => { events.push(e); }, { stream });
    const body = events.map((e) => JSON.stringify(e)).join("\n");
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `tickets/${stream}.jsonl`,
      Body: body,
    }));
  })
  .build();
```

Reads: *"autocloses is Resolved after 90 days; archives to `tickets/${stream}.jsonl` first."* The cycle does the rest — predicate matches, archiver runs, truncate fires. See the full file at [examples/s3-jsonl-archiver.ts](examples/s3-jsonl-archiver.ts) for the wired state with action handlers and event schemas.

## What this recipe is NOT

- **A full-system backup.** Archiving individual streams on close gives you the events of *closed* streams in cold storage. It doesn't give you a snapshot of the live database, the streams table, lease state, projection rows, or anything else. Use `pg_dump` (or your provider's managed backup) for full disaster recovery. Use WAL archiving for point-in-time recovery.
- **Real-time replication.** The archive cycle runs on `autocloseCycleMs` cadence (default 60 s) and only on streams that are being closed. If you need every event mirrored to a downstream consumer in flight, that's a reaction problem — forward via [@rotorsoft/act-http/webhook](../../../libs/act-http/README.md) or a message bus.
- **A query interface over the archived data.** S3 holds the JSONL; nothing in the framework reads it back. Rehydrating a projection from archived JSONL is possible (parse the file, replay through your `.patch` handlers) but it's host code, not a framework primitive. For *in-store* projection rebuild, use [`app.reset(targets)`](../../../docs/docs/concepts/event-sourcing.md) — that walks the live events table, not the archive.

## Cross-references

- [.autocloses + .archives full reference](../../../docs/docs/guides/close-policies.md)
- [Production checklist § 10 (closing the books)](../../../docs/docs/guides/production-checklist.md)
- [Scaling decision tree](../README.md)
- [Partitioning gating page](../partitioning/README.md) — for the workloads where close + archive isn't enough
