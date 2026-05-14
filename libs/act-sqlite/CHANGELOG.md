# [@rotorsoft/act-sqlite-v0.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.1...@rotorsoft/act-sqlite-v0.5.2) (2026-05-14)


### Bug Fixes

* **deps:** update dependency @rotorsoft/act to v0.39.0 ([5ca8f1f](https://github.com/rotorsoft/act-root/commit/5ca8f1f2031c72aef4b85efcb3f999285d23b5f7))

# [@rotorsoft/act-sqlite-v0.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.0...@rotorsoft/act-sqlite-v0.5.1) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-sqlite-v0.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.4.0...@rotorsoft/act-sqlite-v0.5.0) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))


### Features

* **act:** per-stream reaction priority lanes (ACT-102) ([c08f18a](https://github.com/rotorsoft/act-root/commit/c08f18a05bbf478c4e0128dbd175897bb18dd701))

# [@rotorsoft/act-sqlite-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.4...@rotorsoft/act-sqlite-v0.4.0) (2026-05-10)


### Features

* **act:** add Store.notify hook for cross-process drain wakeup (ACT-101) ([f1f40cf](https://github.com/rotorsoft/act-root/commit/f1f40cf608ba107c88bd0a0144c49af2ece47fe7))

# [@rotorsoft/act-sqlite-v0.3.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.3...@rotorsoft/act-sqlite-v0.3.4) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-sqlite-v0.3.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.2...@rotorsoft/act-sqlite-v0.3.3) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-sqlite-v0.3.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.1...@rotorsoft/act-sqlite-v0.3.2) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-sqlite-v0.3.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.3.0...@rotorsoft/act-sqlite-v0.3.1) (2026-05-03)

# [@rotorsoft/act-sqlite-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.2.1...@rotorsoft/act-sqlite-v0.3.0) (2026-05-02)


* fix(deps)!: declare @rotorsoft/act as peer dep in adapters ([785b7b7](https://github.com/rotorsoft/act-root/commit/785b7b71ad223e0ca10944a0cc514ecd59a714ac)), closes [#632](https://github.com/rotorsoft/act-root/issues/632) [#632](https://github.com/rotorsoft/act-root/issues/632)


### BREAKING CHANGES

* consumers of @rotorsoft/act-pg, @rotorsoft/act-sqlite,
and @rotorsoft/act-pino must explicitly declare @rotorsoft/act as a
direct dependency. In practice every consumer that uses an adapter
already imports from @rotorsoft/act directly, so this formalizes
existing reality. After upgrading to the new adapter versions a single
time, future bumps to @rotorsoft/act alone are sufficient — adapters
follow automatically via the wide peer range.

# [@rotorsoft/act-sqlite-v0.2.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.2.0...@rotorsoft/act-sqlite-v0.2.1) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-sqlite-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.3...@rotorsoft/act-sqlite-v0.2.0) (2026-04-27)


### Features

* **act:** add Store.query_streams for subscription introspection ([508c724](https://github.com/rotorsoft/act-root/commit/508c724a4176750dea5d9356e2e8290496331e61))

# [@rotorsoft/act-sqlite-v0.1.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.2...@rotorsoft/act-sqlite-v0.1.3) (2026-04-27)


### Bug Fixes

* **deps:** update dependency @libsql/client to ^0.17.3 ([e88a32a](https://github.com/rotorsoft/act-root/commit/e88a32aa33e3a59885ae789ea8040d730ef96885))

# [@rotorsoft/act-sqlite-v0.1.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.1...@rotorsoft/act-sqlite-v0.1.2) (2026-04-27)


### Bug Fixes

* **act-sqlite:** tighten regex→LIKE stream pattern conversion ([7af3bad](https://github.com/rotorsoft/act-root/commit/7af3badb4eabeb08865e03ecb6273e327235788f))

# [@rotorsoft/act-sqlite-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.1.0...@rotorsoft/act-sqlite-v0.1.1) (2026-04-26)


### Bug Fixes

* **act-sqlite:** reset version to 0.1.0 baseline ([c92712b](https://github.com/rotorsoft/act-root/commit/c92712b1fb89c8caf2fc836054f5549129a38063))
