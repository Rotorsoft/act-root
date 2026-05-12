# [@rotorsoft/act-pg-v0.21.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.2...@rotorsoft/act-pg-v0.21.0) (2026-05-12)


### Features

* **act:** test helpers — sandbox + fixture for parallel-safe per-test isolation (ACT-503) ([ea38cf5](https://github.com/rotorsoft/act-root/commit/ea38cf5136417531f5cc46313e8c4a587221958e))

# [@rotorsoft/act-pg-v0.20.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.1...@rotorsoft/act-pg-v0.20.2) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-pg-v0.20.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.20.0...@rotorsoft/act-pg-v0.20.1) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))

# [@rotorsoft/act-pg-v0.20.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.19.0...@rotorsoft/act-pg-v0.20.0) (2026-05-10)


### Features

* **act-pg:** add PG single-process reaction latency bench (ACT-103) ([8554f57](https://github.com/rotorsoft/act-root/commit/8554f5782ef0b8905e39171e3711934a5960e03a))
* **act:** per-stream reaction priority lanes (ACT-102) ([c08f18a](https://github.com/rotorsoft/act-root/commit/c08f18a05bbf478c4e0128dbd175897bb18dd701))
* **act:** reaction latency bench + workspace bench unification (ACT-103) ([79d419d](https://github.com/rotorsoft/act-root/commit/79d419dbee73dc0fbda65599e4f687362471aecd))

# [@rotorsoft/act-pg-v0.19.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.6...@rotorsoft/act-pg-v0.19.0) (2026-05-10)


### Features

* **act:** add Store.notify hook for cross-process drain wakeup (ACT-101) ([f1f40cf](https://github.com/rotorsoft/act-root/commit/f1f40cf608ba107c88bd0a0144c49af2ece47fe7))

# [@rotorsoft/act-pg-v0.18.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.5...@rotorsoft/act-pg-v0.18.6) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-pg-v0.18.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.4...@rotorsoft/act-pg-v0.18.5) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-pg-v0.18.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.3...@rotorsoft/act-pg-v0.18.4) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-pg-v0.18.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.2...@rotorsoft/act-pg-v0.18.3) (2026-05-03)

# [@rotorsoft/act-pg-v0.18.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.1...@rotorsoft/act-pg-v0.18.2) (2026-05-03)

# [@rotorsoft/act-pg-v0.18.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.18.0...@rotorsoft/act-pg-v0.18.1) (2026-05-02)


### Bug Fixes

* **act-pg:** update test bench import after src/internal move ([935c5b5](https://github.com/rotorsoft/act-root/commit/935c5b5e8e2ef1da391f5f94938c281f0bb63b68))

# [@rotorsoft/act-pg-v0.18.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.17.1...@rotorsoft/act-pg-v0.18.0) (2026-05-02)


* fix(deps)!: declare @rotorsoft/act as peer dep in adapters ([785b7b7](https://github.com/rotorsoft/act-root/commit/785b7b71ad223e0ca10944a0cc514ecd59a714ac)), closes [#632](https://github.com/rotorsoft/act-root/issues/632) [#632](https://github.com/rotorsoft/act-root/issues/632)


### BREAKING CHANGES

* consumers of @rotorsoft/act-pg, @rotorsoft/act-sqlite,
and @rotorsoft/act-pino must explicitly declare @rotorsoft/act as a
direct dependency. In practice every consumer that uses an adapter
already imports from @rotorsoft/act directly, so this formalizes
existing reality. After upgrading to the new adapter versions a single
time, future bumps to @rotorsoft/act alone are sufficient — adapters
follow automatically via the wide peer range.

# [@rotorsoft/act-pg-v0.17.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.17.0...@rotorsoft/act-pg-v0.17.1) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-pg-v0.17.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.16.0...@rotorsoft/act-pg-v0.17.0) (2026-04-27)


### Features

* **act:** add Store.query_streams for subscription introspection ([508c724](https://github.com/rotorsoft/act-root/commit/508c724a4176750dea5d9356e2e8290496331e61))

# [@rotorsoft/act-pg-v0.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.15.0...@rotorsoft/act-pg-v0.16.0) (2026-04-13)


### Bug Fixes

* **act-pg:** per-stream DELETE in loop instead of RETURNING all rows ([1d604bf](https://github.com/rotorsoft/act-root/commit/1d604bfcac5d43b74d91adf06f1836ad68856361))
* **act:** pass proper meta from close() to store.truncate() ([2dbd31a](https://github.com/rotorsoft/act-root/commit/2dbd31a50eac4189f3b011fabf9030db7d704c14))
* **act:** truncate returns committed seeds for correct cache warming ([f42fb94](https://github.com/rotorsoft/act-root/commit/f42fb9421ed9a0808baf14bec797631729477e44))
* **act:** use Schema and EventMeta types in truncate implementations ([6c958a6](https://github.com/rotorsoft/act-root/commit/6c958a66b1dd15aa84750e20df976ff0bdbc8407))


### Features

* **act:** add close-the-books stream archival and truncation ([30d6587](https://github.com/rotorsoft/act-root/commit/30d6587c903022da5d0f10fa3b7b90521c2d60ce)), closes [#562](https://github.com/rotorsoft/act-root/issues/562)
* **act:** atomic guard-first close with truncate+seed transaction ([034e20a](https://github.com/rotorsoft/act-root/commit/034e20a5b2ee037cdd90af3531bf03c7115ebbd5))


### Performance Improvements

* **act-pg:** single DELETE RETURNING instead of SELECT count + DELETE ([fb00704](https://github.com/rotorsoft/act-root/commit/fb007047aa980e4c2d44be0d9cb1adf527b31370))

# [@rotorsoft/act-pg-v0.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.4...@rotorsoft/act-pg-v0.15.0) (2026-04-11)


### Features

* **act, act-pg:** add Store.reset() for projection rebuild ([66fa95a](https://github.com/rotorsoft/act-root/commit/66fa95ac63e03da4da472f14cc3776c1f09b1826)), closes [#564](https://github.com/rotorsoft/act-root/issues/564)

# [@rotorsoft/act-pg-v0.14.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.3...@rotorsoft/act-pg-v0.14.4) (2026-04-09)


### Bug Fixes

* **act:** harden framework with correctness and safety fixes ([7b6406a](https://github.com/rotorsoft/act-root/commit/7b6406aa5e7179e4d0a7bf3e91829670dd51226b))

# [@rotorsoft/act-pg-v0.14.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.2...@rotorsoft/act-pg-v0.14.3) (2026-04-08)


### Performance Improvements

* **act:** add PostgreSQL batch projection benchmark — 20x speedup ([44a4d06](https://github.com/rotorsoft/act-root/commit/44a4d0694a14914b04591002351661c3a2df82d0))
* **act:** pg batch benchmark at 1K/5K/10K — consistent ~19x speedup ([4b25585](https://github.com/rotorsoft/act-root/commit/4b25585b63c472b5fd43882c4cf5d3a63fe16daf))

# [@rotorsoft/act-pg-v0.14.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.1...@rotorsoft/act-pg-v0.14.2) (2026-03-29)


### Bug Fixes

* **security:** sanitize SQL identifiers, escape RegExp, fix code injection vectors ([afbe25e](https://github.com/rotorsoft/act-root/commit/afbe25e5e61c75d0d245070bb6c9b79affb9fe74))

# [@rotorsoft/act-pg-v0.14.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.14.0...@rotorsoft/act-pg-v0.14.1) (2026-03-27)


### Bug Fixes

* **act, act-pg:** add stream_exact query option for exact stream matching ([1ed4e5b](https://github.com/rotorsoft/act-root/commit/1ed4e5bf98ac454d60ea5aa9563e5338c75e2b2d))

# [@rotorsoft/act-pg-v0.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.13.1...@rotorsoft/act-pg-v0.14.0) (2026-03-25)


### Features

* **act:** add Logger interface JSDoc cross-references ([e9772d5](https://github.com/rotorsoft/act-root/commit/e9772d54fc5e70eed9b010d97efdfe96a68d1bfb))

# [@rotorsoft/act-pg-v0.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.13.0...@rotorsoft/act-pg-v0.13.1) (2026-03-16)


### Bug Fixes

* clear _needs_drain on empty claim, 100% line/function coverage, realistic PG bench ([08e350a](https://github.com/rotorsoft/act-root/commit/08e350a932d7a7deb7fe5101c346831c0386858a))

# [@rotorsoft/act-pg-v0.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.12.0...@rotorsoft/act-pg-v0.13.0) (2026-03-15)


### Features

* **act-pg:** pass through full pg.PoolConfig for connection tuning ([d8c8da9](https://github.com/rotorsoft/act-root/commit/d8c8da9001ce33ec85b4711e9a22c4204d293a56))

# [@rotorsoft/act-pg-v0.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.11.0...@rotorsoft/act-pg-v0.12.0) (2026-03-15)


### Features

* **act:** watermark-aware claim filtering ([23fcb78](https://github.com/rotorsoft/act-root/commit/23fcb7838dfd9c115d35faeb59cbf5989200028e))

# [@rotorsoft/act-pg-v0.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.10.0...@rotorsoft/act-pg-v0.11.0) (2026-03-15)


### Features

* **act:** correlation checkpoint with static resolver optimization ([2291906](https://github.com/rotorsoft/act-root/commit/2291906202aa5fdc332b7e9c96fc63fea85c8b8e))

# [@rotorsoft/act-pg-v0.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.9.0...@rotorsoft/act-pg-v0.10.0) (2026-03-15)


### Features

* **act:** replace poll/lease with claim/subscribe ([18a1444](https://github.com/rotorsoft/act-root/commit/18a1444f287046d1b1612e7f35f02f11e0a4e729))


### Performance Improvements

* **act:** add multi-worker contention benchmark ([9787cb6](https://github.com/rotorsoft/act-root/commit/9787cb6caec65787fd80f8f4aa31674ddd121a1f))

# [@rotorsoft/act-pg-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.4...@rotorsoft/act-pg-v0.9.0) (2026-03-14)


### Features

* **act:** add PostgresStore cache benchmark and fix coverage ([8f8a901](https://github.com/rotorsoft/act-root/commit/8f8a901f326b637d94de075c129dbb3bc6e0d04d))
* **act:** add snap variants to cache benchmarks ([83ae55b](https://github.com/rotorsoft/act-root/commit/83ae55ba421669453280764729c1fae87372e81b))
* **act:** always-on cache with snap timing fix ([f797233](https://github.com/rotorsoft/act-root/commit/f7972335ee507bffe75b184e599b5b6298aaeee4))

# [@rotorsoft/act-pg-v0.8.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.3...@rotorsoft/act-pg-v0.8.4) (2026-03-14)


### Bug Fixes

* **act:** use workspace:^ and order CD matrix by dependency chain ([4a5287e](https://github.com/rotorsoft/act-root/commit/4a5287eb53a038cf8e81fcc8493427f7125fd94e))

# [@rotorsoft/act-pg-v0.8.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.2...@rotorsoft/act-pg-v0.8.3) (2026-03-13)


### Bug Fixes

* **act-pg:** use sequential inserts in commit to avoid pg deprecation warning ([92162a2](https://github.com/rotorsoft/act-root/commit/92162a29c6ea5e01a3484569de0261def8f6d99a))

# [@rotorsoft/act-pg-v0.8.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.1...@rotorsoft/act-pg-v0.8.2) (2026-03-05)


### Bug Fixes

* **deps:** update dependency pg to ^8.20.0 ([fa3dfd2](https://github.com/rotorsoft/act-root/commit/fa3dfd235ea04a3635b9bbbeeaea0eda291d8213))

# [@rotorsoft/act-pg-v0.8.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.8.0...@rotorsoft/act-pg-v0.8.1) (2026-03-02)


### Bug Fixes

* **deps:** update dependency pg to ^8.19.0 ([1610622](https://github.com/rotorsoft/act-root/commit/16106223189d4612a614455eeec7b3a025fc62b9))

# [@rotorsoft/act-pg-v0.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.7.0...@rotorsoft/act-pg-v0.8.0) (2026-02-20)


### Features

* **act:** streamline state builder with passthrough defaults ([fe1362f](https://github.com/rotorsoft/act-root/commit/fe1362fd912c14257fb4cfa1e765d0c85c5eb410))

# [@rotorsoft/act-pg-v0.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.6.0...@rotorsoft/act-pg-v0.7.0) (2026-02-18)


### Features

* rename builder methods to improve typings ([a22dd89](https://github.com/rotorsoft/act-root/commit/a22dd8969b52525fa340a9d4d35b4a679fdb2242))

# [@rotorsoft/act-pg-v0.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pg-v0.5.22...@rotorsoft/act-pg-v0.6.0) (2026-02-13)


### Features

* **act:** replace state("Name", schema) with state({ Name: schema }) record shorthand ([db9a3f2](https://github.com/rotorsoft/act-root/commit/db9a3f24b661c784496d8a51c0e5176b453a6423)), closes [#390](https://github.com/rotorsoft/act-root/issues/390)
