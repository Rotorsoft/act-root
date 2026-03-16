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
