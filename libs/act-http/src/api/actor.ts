import type { Actor } from "@rotorsoft/act";

/**
 * Extractor function the host supplies to resolve an {@link Actor}
 * from an incoming request. The framework keeps auth out of the
 * package — JWT vs session vs API key is the host's call — and asks
 * for this single closure that every transport (tRPC, Hono, OpenAPI
 * docs) composes against.
 *
 * The `request` argument is intentionally generic. Each transport
 * narrows it at the call site (`IncomingMessage` for Hono, the tRPC
 * context object for tRPC, etc.) — keeping the contract here
 * transport-agnostic means one extractor implementation plugs into
 * every adapter unchanged.
 *
 * Async is allowed so the extractor can verify a JWT against a
 * remote JWKS endpoint without forcing every host to synchronously
 * cache.
 */
export type ActorExtractor = (request: unknown) => Actor | Promise<Actor>;
