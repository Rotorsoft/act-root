# npm Trusted Publishing migration

Moving Act's CD publish path off long-lived npm tokens.

> **This is no longer preventative work.** Publishing broke on **2026-08-18**,
> well ahead of the ~January 2027 deadline this checklist was written for. The
> token stopped being accepted mid-day: the same pipeline published
> `@rotorsoft/act-pg@1.15.1` successfully on 2026-08-17, and the next run
> ([32141894683](https://github.com/Rotorsoft/act-root/actions/runs/32141894683))
> failed with `404 Not Found - PUT https://registry.npmjs.org/@rotorsoft%2fact`
> for every package. npm answers 404 rather than 403 on a scoped package when
> the caller is not authorized. There is no working fallback to migrate away
> from — completing this checklist **is** the fix.

## Current state

| Piece | Status |
|---|---|
| Publish job | `.github/workflows/ci-cd.yml` → `cd` matrix → `npx semantic-release` |
| Publish command | `pnpm publish --no-git-checks --access public` via `@semantic-release/exec` |
| Auth | ❌ `secrets.NPM_TOKEN` no longer accepted by npm |
| OIDC permission | ✅ Already set: `id-token: write` on the `cd` job |
| Provenance | ✅ Already set: `NPM_CONFIG_PROVENANCE: true` |
| Trusted Publisher config | ❌ Not registered for any package — this is the gap |
| Install path | `pnpm install` (npm v12 install-time defaults do not gate CI) |

Provenance OIDC is **not** the same as trusted-publishing auth — both need
`id-token: write`, but trusted publishing also needs a Trusted Publisher config
on npmjs.com.

### What the failure log already proves

```
GET [secure]&audience=npm%3Aregistry.npmjs.org 200 256ms
[WARN] Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE ... (status code 404)
[E404] 404 Not Found - PUT https://registry.npmjs.org/@rotorsoft%2fact
```

The `200` is GitHub minting the OIDC identity token — that half works today.
pnpm then offered it to npm, which returned 404 because **no Trusted Publisher
is registered for the package**. Registering one turns that exchange into a
short-lived publish token. The `Skipped OIDC` line is not new and was never the
problem: the successful 2026-08-17 run logged it too, then fell back to a token
that still worked.

pnpm attempts the exchange **whether or not** a static token is present, so
removing `NPM_TOKEN` is hygiene, not the enabler.

## Timeline

| When | Change | Impact here |
|---|---|---|
| npm v12 `latest` | Install-time defaults: scripts / git / remote deps opt-in | Low — CI uses pnpm |
| ~early August 2026 | 2FA-bypass GAT cannot do account / org / package management | Do those ops interactively with 2FA |
| **2026-08-18 (actual)** | **Token rejected; every publish 404s** | **CD is broken now** |
| ~January 2027 | 2FA-bypass GAT cannot publish directly | Moot once migrated |

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

- [x] `pnpm` attempts the OIDC exchange natively — repo pins
      `packageManager: pnpm@11.21.0` (the checklist previously said 11.17.0),
      and the 2026-08-18 log shows it trying the exchange unprompted.
- [x] Node stays ≥ `22.14.0` — workflow pins `22.23.2`
- [x] GitHub-hosted runners (self-hosted OIDC for npm is not supported yet)
- [ ] **Escape hatch is not usable as written.** Switching `publishCmd` to
      `npm publish` needs npm CLI ≥ `11.5.1`, and Node 22.23.2 ships npm 10.x —
      that route needs an explicit `npm i -g npm@latest` step added first.
      Worth knowing before reaching for it mid-incident.

### Validation (no dual-auth available)

The original plan validated one package while keeping the token as a safety
net. The token is dead, so there is no net: registering the publisher **is**
the recovery, and the first successful publish is the validation.

- [ ] Register the Trusted Publisher for `@rotorsoft/act-patch` first (small,
      easy to release on its own)
- [ ] Land the workflow change dropping `NPM_TOKEN` / `NODE_AUTH_TOKEN` — safe
      to merge on its own: it touches no `libs/` path, so `cd` does not run
- [ ] Trigger a release with a trivial `fix(act-patch):` commit on master
- [ ] Confirm the log shows a successful exchange rather than `Skipped OIDC`
- [ ] Confirm the published version shows provenance on npmjs.com

### Then the rest

- [ ] Register Trusted Publishers for the remaining twelve packages
- [ ] Delete the `NPM_TOKEN` repository secret
- [ ] Keep `NPM_CONFIG_PROVENANCE: true` — trusted publishing enables provenance
      by default, but the explicit flag survives a change of publish path

### Stranded versions from the 2026-08-18 failure

semantic-release commits the version bump and pushes the tag **before** the
publish step, so four releases exist in git and not on npm:

| Package | git tag | on npm |
|---|---|---|
| `@rotorsoft/act` | 1.28.0 | 1.27.0 |
| `@rotorsoft/act-pg` | 1.16.0 | 1.15.1 |
| `@rotorsoft/act-sqlite` | 1.16.0 | 1.15.0 |
| `@rotorsoft/act-tck` | 1.33.0 | 1.32.0 |

No GitHub releases were created either — that plugin also runs after publish.

- [ ] Decide: leave the gap (recommended — nobody can have pinned a version
      that never existed, and the next merge takes the following numbers), or
      publish the four by hand. Note a manual publish needs an interactive
      `npm login` with 2FA, since trusted publishing only works from inside the
      workflow, and it produces no provenance.
- [ ] Re-running the failed jobs does **not** republish them: semantic-release
      sees the tags already present and concludes there is nothing to release.

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
