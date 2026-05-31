/**
 * @packageDocumentation
 * @module act-http/receiver/trpc
 *
 * tRPC adapter for the receiver-side webhook check. Composes
 * `extractIdempotencyKey` + `verifyWebhook` + `IdempotencyStore.claim`
 * into a single middleware factory.
 *
 * Usage:
 *
 * ```ts
 * import { initTRPC, TRPCError } from "@trpc/server";
 * import { webhookReceiver } from "@rotorsoft/act-http/receiver/trpc";
 * import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
 *
 * type Ctx = {
 *   headers: Record<string, string | string[] | undefined>;
 *   rawBody: string;
 * };
 *
 * const t = initTRPC.context<Ctx>().create();
 * const dedup = new InMemoryIdempotencyStore();
 *
 * const idempotent = t.procedure.use(
 *   webhookReceiver({ store: dedup, secret: process.env.WEBHOOK_SECRET })
 * );
 * ```
 *
 * The middleware throws a `TRPCError` with `BAD_REQUEST` for
 * `missing-key` and `UNAUTHORIZED` for any verification failure.
 * On success it injects `{ key, deduped }` into the request context
 * under the `idempotency` property.
 *
 * **Raw body requirement**: when `secret` is configured, the middleware
 * needs the raw request bytes for HMAC verification. Capture them in
 * `createContext` — most tRPC HTTP adapters expose the raw stream;
 * read it into a string and stash it on `ctx.rawBody`. Skip when
 * unsigned (no `secret`) — the middleware never reads `rawBody` in
 * that mode.
 */
import { TRPCError } from "@trpc/server";
import { type CheckWebhookOptions, checkWebhook } from "../check.js";

/**
 * Build a tRPC middleware that verifies the request signature (when
 * `secret` is set), enforces `Idempotency-Key`, and claims the key on
 * the configured store. See the module-level docs for usage.
 *
 * The returned function uses permissive `any` typing because tRPC's
 * `MiddlewareFunction` type lives in `unstable-core-do-not-import`
 * (internal namespace, not for external import). Type-safety at the
 * call site comes from `t.procedure.use(...)` validating the
 * middleware shape against the procedure's context — the operator's
 * tRPC context must include `headers` and `rawBody`, and downstream
 * handlers see `ctx.idempotency = { key, deduped }`.
 */
// biome-ignore lint/suspicious/noExplicitAny: tRPC's internal middleware shape
export function webhookReceiver(options: CheckWebhookOptions): any {
  return async function check(opts: {
    ctx: {
      headers: Record<string, string | string[] | undefined>;
      rawBody: string;
    };
    // biome-ignore lint/suspicious/noExplicitAny: see above
    next: (next: { ctx: any }) => Promise<any>;
  }) {
    const result = await checkWebhook(
      opts.ctx.headers,
      opts.ctx.rawBody,
      options
    );
    if (!result.ok) {
      throw new TRPCError({
        code: result.status === 400 ? "BAD_REQUEST" : "UNAUTHORIZED",
        message: result.reason,
      });
    }
    return opts.next({
      ctx: {
        ...opts.ctx,
        idempotency: { key: result.key, deduped: result.deduped },
      },
    });
  };
}
