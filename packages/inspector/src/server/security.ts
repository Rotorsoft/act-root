/**
 * HTTP-boot security policy (#1195).
 *
 * The pure decision functions live here — separate from `server.ts`,
 * which is the un-unit-tested boot wiring — so the bind-host default,
 * the CORS origin decision, and the mutating-procedure guard are all
 * covered by the test suite. `server.ts` imports these and does
 * nothing but pass them to `createHTTPServer` / `server.listen`.
 */

/**
 * Bind host resolution. The inspector exposes an *unauthenticated*
 * tRPC surface (file transfer, prioritize, …), so it binds loopback
 * only by default — reachable from the operator's own machine, not
 * the network. An operator who deliberately wants network exposure
 * sets `ACT_INSPECTOR_HOST` (e.g. `0.0.0.0`); when they bind to
 * anything other than loopback we log a warning so the exposure is
 * never silent.
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function resolveBindHost(
  envHost: string | undefined,
  warn: (msg: string) => void = console.warn
): string {
  const host = envHost && envHost.length > 0 ? envHost : DEFAULT_BIND_HOST;
  if (!LOOPBACK.has(host))
    warn(
      `[inspector] binding to ${host} — the unauthenticated inspector surface is reachable from the network. Ensure this host is firewalled or behind auth.`
    );
  return host;
}

/**
 * CORS origin decision. Two modes:
 *
 *   - `CORS_ORIGIN` set — strict allowlist, echo only that exact
 *     origin.
 *   - unset (local dev) — any `http(s)://localhost[:port]` origin is
 *     allowed so the Vite client on a varying port keeps working.
 *
 * Origin-less requests (`origin === undefined`) are *not* blanket
 * allowed here — the mutating-procedure guard below refuses them for
 * writes. Reads with no origin still pass so curl / same-origin
 * fetches work in local dev.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: string | undefined
): boolean {
  if (allowlist) return origin === allowlist;
  if (!origin) return true;
  return /^https?:\/\/localhost(:\d+)?$/.test(origin);
}

/**
 * Mutating-procedure origin guard (#1195). A cross-site request can
 * omit the `Origin` header, so we don't let an origin-less request
 * reach a *mutating* tRPC procedure unless an explicit allowlist is
 * configured (which pins the caller). Reads are unaffected — they
 * pass through for local-dev ergonomics (curl, same-origin fetch).
 *
 * Returns true when the request is allowed to mutate.
 */
export function mutationOriginAllowed(
  origin: string | undefined,
  allowlist: string | undefined
): boolean {
  // With an explicit allowlist, the origin must match it exactly —
  // origin-less requests can't satisfy an allowlist, so they're out.
  if (allowlist) return origin === allowlist;
  // No allowlist (local dev): require a localhost origin for mutations.
  // Origin-less mutations are refused — that's the CSRF hardening.
  if (!origin) return false;
  return /^https?:\/\/localhost(:\d+)?$/.test(origin);
}
