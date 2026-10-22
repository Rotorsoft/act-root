---
paths:
  - "libs/**/*.{ts,tsx}"
  - "packages/**/*.{ts,tsx}"
  - "recipes/**/*.ts"
  - "test/**/*.ts"
---

# Naming conventions

The codebase uses two distinct casings. Which one you pick is determined by **whether the identifier is on the public surface or not** — there is no third "shifting style by context" option.

**Public — camelCase. This is the convention, not a legacy carve-out.**

Anything reachable from a package's `src/index.ts` (or subpath `index.ts` for `act-http`/`act-ops`) is camelCase:

- Exported functions: `verifyWebhook`, `applyPatchMessage`, `withIdempotency`, `runStoreTck`, `webhookMiddleware`, `minSafeTtl`, `extractIdempotencyKey`, `checkWebhook`.
- Public type fields: `IAct.forget` return `{eventCount}`, `forgotten` event `eventCount`, `StateNode.varName`, `EventNode.hasCustomPatch`, `WebhookConfig.timeoutMs`/`idempotencyKey`, `HttpDeliveryErrorInit.responseBody`, `VerifyOptions.maxAgeSeconds`, `RetryProfile.safetyFactor`, `Projection.batchHandler`, `QueryStreamsResult.maxEventId`, `InMemoryIdempotencyStore` options `ttlMs`/`maxEntries`/`retryProfile`.
- ActOptions / RetryOptions / ReactionOptions / Backoff / DrainOptions / SettleOptions / LaneConfig fields: `maxRetries`, `blockOnError`, `baseMs`, `maxMs`, `jitter`, `strategy`, `leaseMillis`, `eventLimit`, `streamLimit`, `cycleMs`, `debounceMs`, `maxSubscribedStreams`, `onlyLanes`, `settleDebounceMs`, `maxPasses`, `expectedVersion`, `reactingTo`, `asOf`, `maxSize`.
- Builder methods: `withState`, `withProjection`, `withReaction`, `withActor`, `withLane`, `withSlice`.
- Top-level factories: short single-word lowercase — `act`, `state`, `slice`, `projection`, `sensitive`, `webhook`, `receiver`.
- Public class names + types — PascalCase always: `StateNode`, `BroadcastChannel`, `InMemoryStore`, `ConsoleLogger`, `RetryProfile`, `WebhookConfig`, `IdempotencyStore`. Suffix with `XxxOptions` / `XxxResult` / `XxxConfig` when applicable.

**Internal — short snake_case, no exceptions:**

- Internal helper functions: `run_close_cycle`, `classify_registry`, `compute_backoff_delay`, `build_handle`, `merge_event_register`, `current_version_of`.
- Local variables: `event_to_state`, `last_event_name`, `stream_info`, `raw_body`, `headers_bag`.
- Function parameters: TS doesn't enforce parameter names as part of the public contract (callers pass positional args), so parameters are snake_case even on public method signatures — `event_name`, `state_name`, `skip_validation`.
- Private/protected class fields and methods: `_snake_case` with underscore prefix — `_drain_controllers`, `_event_to_lanes`, `_arm_all`, `_wire_notify`, `_max_event_id_by_stream`.
- Internal type fields (types not re-exported through any `src/index.ts`): `Classification.static_targets`, `HandleResult.next_attempt_at`, `AuditPass.on_event`, `SettleDeps.on_settled`.
- Grouping prefixes/postfixes when several related identifiers share a structural role: `pii_*`, `make_*`, `is_*`, `compute_*`, `*_by_stream`.

**Parameter properties are banned** by `erasableSyntaxOnly`: declare each field explicitly above the constructor and assign in the body. Constructor parameter names stay camelCase (matches the external call site); rename to `_snake_case` only on the assignment to the field.

**The boundary is enforced mechanically** by `runStabilityTck` from `@rotorsoft/act-tck`. One spec, `test/stability.spec.ts` (at the repo root, so a snapshot change never releases a package), discovers every `@rotorsoft/*` package under `libs/` and snapshots the published declarations (`dist/@types`) of each entry point declared in its `exports`, following its relative re-exports. Any rename / removal / signature change on the public surface shows up as a snapshot diff in the PR; an implementation change doesn't. New packages and subpaths are picked up automatically. It reads `dist/`, so it runs after `pnpm build` as `pnpm check:stability` (`-u` to regenerate), not in `pnpm test`.
