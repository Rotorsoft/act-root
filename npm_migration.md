# npm Trusted Publishing migration

Checklist for moving Act's CD publish path off long-lived npm tokens before the
[2FA-bypass GAT deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
breaks unattended releases (~January 2027).

## Current state

| Piece | Status |
|---|---|
| Publish job | `.github/workflows/ci-cd.yml` → `cd` matrix → `npx semantic-release` |
| Publish command | `pnpm publish --no-git-checks --access public` via `@semantic-release/exec` |
| Auth | `secrets.NPM_TOKEN` → `NPM_TOKEN` + `NODE_AUTH_TOKEN` |
| OIDC permission | Already set: `id-token: write` on the `cd` job |
| Provenance | Already set: `NPM_CONFIG_PROVENANCE: true` |
| Install path | `pnpm install` (npm v12 install-time defaults do not gate CI) |

Auth still uses a long-lived token. Provenance OIDC is **not** the same as
trusted-publishing auth — both need `id-token: write`, but trusted publishing
also needs a Trusted Publisher config on npmjs.com and no publish token.

## Timeline (from the changelog)

| When | Change | Impact here |
|---|---|---|
| Now (npm v12 `latest`) | Install-time defaults: scripts / git / remote deps opt-in | Low — CI uses pnpm |
| ~early August 2026 | 2FA-bypass GAT cannot do account / org / package management | Do those ops interactively with 2FA |
| ~January 2027 | 2FA-bypass GAT cannot publish directly | **CD breaks** unless migrated |

## Packages to configure

Add a Trusted Publisher on npmjs.com for each published `@rotorsoft/*` package:

- [ ] `@rotorsoft/act`
- [ ] `@rotorsoft/act-pg`
- [ ] `@rotorsoft/act-sqlite`
- [ ] `@rotorsoft/act-patch`
- [ ] `@rotorsoft/act-http`
- [ ] `@rotorsoft/act-sse`
- [ ] `@rotorsoft/act-pino`
- [ ] `@rotorsoft/act-notify`
- [ ] `@rotorsoft/act-otel`
- [ ] `@rotorsoft/act-crypto`
- [ ] `@rotorsoft/act-ops`
- [ ] `@rotorsoft/act-tck`
- [ ] `@rotorsoft/act-diagram`

For each package → **Settings → Trusted Publisher → GitHub Actions**:

| Field | Value |
|---|---|
| Organization / user | `Rotorsoft` (match npm’s case rules) |
| Repository | `act-root` |
| Workflow filename | `ci-cd.yml` (basename only) |
| Environment | leave empty unless the job gains an `environment:` |
| Allowed actions | `npm publish` (and staged publish only if you opt into that flow) |

## Workflow cutover

### Pre-flight

- [ ] Confirm runner npm CLI ≥ `11.5.1` (OIDC requirement); bump if needed
- [ ] Confirm `pnpm` version supports OIDC overriding a static `_authToken`
      (needed while `NPM_TOKEN` remains as fallback). Repo pins
      `packageManager: pnpm@11.17.0` — verify before relying on dual-auth.
- [ ] Confirm Node stays ≥ `22.14.0` (already on `22.23.1`)
- [ ] Keep using GitHub-hosted runners (self-hosted OIDC for npm is not supported yet)

### Dual-auth validation (one package first)

- [ ] Leave `NPM_TOKEN` / `NODE_AUTH_TOKEN` in place temporarily
- [ ] Land Trusted Publisher config for one package (e.g. `@rotorsoft/act-patch`)
- [ ] Trigger a real release for that package and confirm the log shows OIDC /
      trusted publishing, not only the static token
- [ ] Confirm the published version has provenance on npmjs.com

### Drop the long-lived token

- [ ] Remove `NPM_TOKEN` and `NODE_AUTH_TOKEN` from the `cd` release step in
      `.github/workflows/ci-cd.yml`
- [ ] Re-run a publish; confirm success with tokenless OIDC only
- [ ] Delete the `NPM_TOKEN` repository secret
- [ ] Optionally drop `NPM_CONFIG_PROVENANCE: true` — trusted publishing enables
      provenance by default (keep it if you want the flag explicit)

### semantic-release / pnpm notes

- [ ] Keep `@semantic-release/npm` with `npmPublish: false` and publish via
      `@semantic-release/exec` → `pnpm publish` (current pattern)
- [ ] If OIDC fails under pnpm, temporary escape hatch: switch `publishCmd` to
      `npm publish --access public` (npm CLI OIDC is the reference path), then
      revisit pnpm once confirmed
- [ ] Watch for `actions/setup-node` `registry-url` + `.npmrc` interactions if
      auth errors appear after removing the token — adjust only if a real
      failure shows up

## Account / ops hygiene (from ~August 2026)

- [ ] Stop using any 2FA-bypass GAT for: creating/deleting tokens, changing
      maintainers / access, editing trusted-publisher config, org/team grants
- [ ] Perform those actions interactively with 2FA
- [ ] Prefer a read-only token (if any) for private-package installs; never a
      publish-capable bypass token in CI after cutover

## Out of scope / low priority

- **npm v12 install defaults** — CI installs with pnpm. Revisit only if something
  in the toolchain starts calling `npm install` directly, or local `npm`
  workflows need an `approve-scripts` allowlist.
- **Staged publishing + human 2FA** — valid fallback, but incompatible with
  unattended semantic-release. Prefer trusted publishing.

## Done when

- [ ] Every published `@rotorsoft/*` package has a Trusted Publisher for
      `Rotorsoft/act-root` / `ci-cd.yml`
- [ ] A master release publishes without `NPM_TOKEN` / `NODE_AUTH_TOKEN`
- [ ] The GitHub `NPM_TOKEN` secret is deleted
- [ ] Provenance still appears on new publishes
- [ ] This checklist’s cutover items are all checked

## References

- [npm install-time security and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)
- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/)
- [npm trusted publishing with OIDC (GA)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
- [semantic-release GitHub Actions recipe](https://semantic-release.org/recipes/ci-configurations/github-actions/)
