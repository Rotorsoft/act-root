# [@rotorsoft/act-tck-v1.26.9](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.8...@rotorsoft/act-tck-v1.26.9) (2026-07-11)


### Bug Fixes

* **act-http:** mark sensitive() action-input fields in the openapi request schema ([#1228](https://github.com/rotorsoft/act-root/issues/1228)) ([003eea2](https://github.com/rotorsoft/act-root/commit/003eea2bfd97c35641ee585a0a26cab40fa1c564))
* **act-pg:** per-pool jsonb parser, names:[]/before guards, TCK + docs (ACT-1198/1199) ([1043227](https://github.com/rotorsoft/act-root/commit/10432274edc0ce583563d0902056fd6d6ed7955c)), closes [#1197](https://github.com/rotorsoft/act-root/issues/1197) [#1199](https://github.com/rotorsoft/act-root/issues/1199)
* **act:** orphaned-lane advisory, defer durability across restart, audit lane universe ([1dee16d](https://github.com/rotorsoft/act-root/commit/1dee16d09f4aab2efaef5447ca6c7d924419dd8c))

# [@rotorsoft/act-tck-v1.26.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.7...@rotorsoft/act-tck-v1.26.8) (2026-07-11)


### Bug Fixes

* **act-http:** commit receiver idempotency key on success, not on claim ([9badb1a](https://github.com/rotorsoft/act-root/commit/9badb1afdce72fb4813178fb2ea7e110057a2460)), closes [#1193](https://github.com/rotorsoft/act-root/issues/1193)

# [@rotorsoft/act-tck-v1.26.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.6...@rotorsoft/act-tck-v1.26.7) (2026-07-11)


### Bug Fixes

* **act-pg:** keep the dead listen client's error handler across reconnect ([71624b8](https://github.com/rotorsoft/act-root/commit/71624b86f674cd871f11ec9e4253aeb81886055c)), closes [#1189](https://github.com/rotorsoft/act-root/issues/1189)
* **act:** open autoclose window at the DST spring-forward gap instant ([acf00f3](https://github.com/rotorsoft/act-root/commit/acf00f3308a75cca6f742530a6a95eb373ecf599))
* **act:** reject leading-zero event versions that collide with the canonical form ([4089364](https://github.com/rotorsoft/act-root/commit/4089364d710c12689f486a0cb511272b680d6434))

# [@rotorsoft/act-tck-v1.26.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.5...@rotorsoft/act-tck-v1.26.6) (2026-07-11)


### Bug Fixes

* **act:** restore regex claim sources with a literal fast-path ([3abd00d](https://github.com/rotorsoft/act-root/commit/3abd00d53848948aa0d7a59a4884a47a0e6000eb)), closes [#1215](https://github.com/rotorsoft/act-root/issues/1215) [#1215](https://github.com/rotorsoft/act-root/issues/1215)

# [@rotorsoft/act-tck-v1.26.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.4...@rotorsoft/act-tck-v1.26.5) (2026-07-10)


### Bug Fixes

* **act-pg:** self-healing LISTEN reconnect and widen streams.retry to int ([eb52460](https://github.com/rotorsoft/act-root/commit/eb524607f454ad40002c83cbdf09660309e4eed5)), closes [hi#severity](https://github.com/hi/issues/severity) [#1189](https://github.com/rotorsoft/act-root/issues/1189) [#1190](https://github.com/rotorsoft/act-root/issues/1190)

# [@rotorsoft/act-tck-v1.26.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.3...@rotorsoft/act-tck-v1.26.4) (2026-07-10)


### Bug Fixes

* **act:** close-guard cache poisoning, scoped-port leaks, restore migration remap ([8883b50](https://github.com/rotorsoft/act-root/commit/8883b50758e004ef86086f56dfb3db71e2185702)), closes [#1188](https://github.com/rotorsoft/act-root/issues/1188) [#1191](https://github.com/rotorsoft/act-root/issues/1191) [#1188](https://github.com/rotorsoft/act-root/issues/1188) [#1191](https://github.com/rotorsoft/act-root/issues/1191) [#1192](https://github.com/rotorsoft/act-root/issues/1192)

# [@rotorsoft/act-tck-v1.26.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.2...@rotorsoft/act-tck-v1.26.3) (2026-07-10)


### Bug Fixes

* **act:** type the reaction-scoped iact and repair invariant doc examples ([239137b](https://github.com/rotorsoft/act-root/commit/239137b4668c887a3724d97cc1ea40e1bafe22d1)), closes [#1185](https://github.com/rotorsoft/act-root/issues/1185)

# [@rotorsoft/act-tck-v1.26.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.1...@rotorsoft/act-tck-v1.26.2) (2026-07-10)


### Bug Fixes

* **act-pg:** serialize commit visibility to close the serial-id gap ([b3feaac](https://github.com/rotorsoft/act-root/commit/b3feaac923f379697986092a2e185dd3746f2c09)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)


### Performance Improvements

* **act-pg:** shrink the commit visibility-lock window ([2f300a1](https://github.com/rotorsoft/act-root/commit/2f300a1ebfeb56faa26f8ff86b255668a7afe799)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)
* **act-pg:** single-statement commit makes the visibility lock free ([f911e65](https://github.com/rotorsoft/act-root/commit/f911e65ed78cf1c0f4dd3dd4a0c9fb450316dc3a)), closes [#1178](https://github.com/rotorsoft/act-root/issues/1178)

# [@rotorsoft/act-tck-v1.26.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.0...@rotorsoft/act-tck-v1.26.1) (2026-07-10)


### Bug Fixes

* **act:** never ack past an event with an unhandled reaction ([853071e](https://github.com/rotorsoft/act-root/commit/853071ed5afc6b64bb16bf54aa65b8d986be9195)), closes [#1179](https://github.com/rotorsoft/act-root/issues/1179)

# [@rotorsoft/act-tck-v1.26.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.25.0...@rotorsoft/act-tck-v1.26.0) (2026-07-10)


### Features

* **act-tck:** windowed truncate boundary cases ([838871d](https://github.com/rotorsoft/act-root/commit/838871d7d1c3240d8ac7d5c5d53b10db9f06e825)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)
* **act:** close the books on a rolling window ([b20c2fd](https://github.com/rotorsoft/act-root/commit/b20c2fdec9fb37f8f64514c7b7412bd368d26358)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)

# [@rotorsoft/act-tck-v1.25.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.24.0...@rotorsoft/act-tck-v1.25.0) (2026-07-08)


### Features

* **act-notify:** hybrid notify-broker decorator — ride redis for wakeups ([f5a9300](https://github.com/rotorsoft/act-root/commit/f5a930060a3a08c09167b5b3e18ddd6708e8db06)), closes [#987](https://github.com/rotorsoft/act-root/issues/987)

# [@rotorsoft/act-tck-v1.24.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.23.0...@rotorsoft/act-tck-v1.24.0) (2026-07-08)


### Bug Fixes

* **act:** cache and snapshot writes never lie about their frontier ([ef73607](https://github.com/rotorsoft/act-root/commit/ef736076b473716a6cafbebd45c73cdbdffe1cb3)), closes [#1169](https://github.com/rotorsoft/act-root/issues/1169)


### Features

* **act:** .of() resolves the registry-merged full state at build ([d9dfa3d](https://github.com/rotorsoft/act-root/commit/d9dfa3d8793c83c25aabeef4a923600ea4589b43))

# [@rotorsoft/act-tck-v1.23.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.22.0...@rotorsoft/act-tck-v1.23.0) (2026-07-08)


### Features

* **act:** state projections — projection(name).of(state).flush(handler) ([a5ef582](https://github.com/rotorsoft/act-root/commit/a5ef5827a5e64049f369883e6326790f46d71208)), closes [#1125](https://github.com/rotorsoft/act-root/issues/1125)

# [@rotorsoft/act-tck-v1.22.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.21.0...@rotorsoft/act-tck-v1.22.0) (2026-07-06)


### Features

* **act-pg:** seed-sync is the schema story — pin the contract, harden concurrent boot ([893d620](https://github.com/rotorsoft/act-root/commit/893d620be5ead475f236285a28df17f52e34107c))

# [@rotorsoft/act-tck-v1.21.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.20.1...@rotorsoft/act-tck-v1.21.0) (2026-07-05)


### Bug Fixes

* **act:** correlate arms lane controllers for newly-subscribed streams ([9a23d4c](https://github.com/rotorsoft/act-root/commit/9a23d4c2968623a9581c6efe8facb7571167ced6))


### Features

* **act-otel:** prometheus metrics bridge over the lifecycle events ([c2cafc0](https://github.com/rotorsoft/act-root/commit/c2cafc056476127d2baa667666a8343fb61f6ac6))

# [@rotorsoft/act-tck-v1.20.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.20.0...@rotorsoft/act-tck-v1.20.1) (2026-07-05)


### Bug Fixes

* **act:** failed defer persist never stalls recurrence or drops cycle outcomes ([42a4473](https://github.com/rotorsoft/act-root/commit/42a4473d2049a3fbf3fe8bb9ff6f9125b087f258)), closes [#1124](https://github.com/rotorsoft/act-root/issues/1124)
* **act:** finalize drain cycles atomically — acks and defer schedules in one store call ([9ab2f26](https://github.com/rotorsoft/act-root/commit/9ab2f26e13999b1f8717984cd5bc088b919969e6))

# [@rotorsoft/act-tck-v1.20.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.19.3...@rotorsoft/act-tck-v1.20.0) (2026-07-05)


### Features

* **act-http:** camelcase aliases for sse public members, deprecate snake_case ([#1139](https://github.com/rotorsoft/act-root/issues/1139)) ([71bbcd9](https://github.com/rotorsoft/act-root/commit/71bbcd955228aff8310894707f7ce5983ef6ab85))

# [@rotorsoft/act-tck-v1.19.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.19.2...@rotorsoft/act-tck-v1.19.3) (2026-07-04)


### Bug Fixes

* **act-pg:** skip oversize notify payloads so commits never abort ([#1120](https://github.com/rotorsoft/act-root/issues/1120)) ([982a224](https://github.com/rotorsoft/act-root/commit/982a224a3f8ce2811b783570b33f69154087e43a))

# [@rotorsoft/act-tck-v1.19.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.19.1...@rotorsoft/act-tck-v1.19.2) (2026-07-04)


### Bug Fixes

* **act-pg:** opinionated pool defaults and clear acquisition errors ([#1119](https://github.com/rotorsoft/act-root/issues/1119)) ([c1acdb5](https://github.com/rotorsoft/act-root/commit/c1acdb5c0d1489dfc1f4faa69bc413a06d06a32f))
* **act-sqlite:** throw on non-portable stream filter patterns ([#1114](https://github.com/rotorsoft/act-root/issues/1114)) ([14dad8b](https://github.com/rotorsoft/act-root/commit/14dad8be006d25badef426246a6ea1a2126fb5e4))
* **act:** surface warn-level signal when snapshot write fails ([#1115](https://github.com/rotorsoft/act-root/issues/1115)) ([b221ab1](https://github.com/rotorsoft/act-root/commit/b221ab1290ffdc2d1ddd1c5ddae3684f90982da2))

# [@rotorsoft/act-tck-v1.19.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.19.0...@rotorsoft/act-tck-v1.19.1) (2026-07-04)

# [@rotorsoft/act-tck-v1.19.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.18.0...@rotorsoft/act-tck-v1.19.0) (2026-07-03)


### Features

* **act:** declarative .defer(when) builder step (slice 2, [#1091](https://github.com/rotorsoft/act-root/issues/1091)) ([50e59c3](https://github.com/rotorsoft/act-root/commit/50e59c390fc5fae42d3ebc52b81f5eee29348bdf))
* **act:** public DeferSignal throw for imperative defer (slice 2, [#1091](https://github.com/rotorsoft/act-root/issues/1091)) ([7280560](https://github.com/rotorsoft/act-root/commit/7280560b8c212478bd02f6ab6c2696478fad012d))

# [@rotorsoft/act-tck-v1.18.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.17.1...@rotorsoft/act-tck-v1.18.0) (2026-07-01)


### Bug Fixes

* **act:** run autoclose on a synthetic stream; clamp long defer timers ([#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([d93bfbb](https://github.com/rotorsoft/act-root/commit/d93bfbb67d1ec4ef4245bbc642fdce22c6d0c07e))


### Features

* **act:** add persisted defer outcome + Store.defer (slice 1a-1c, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([c5c46ce](https://github.com/rotorsoft/act-root/commit/c5c46cef7a03c2853434b9e289315d91d2165c59))

# [@rotorsoft/act-tck-v1.17.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.17.0...@rotorsoft/act-tck-v1.17.1) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-tck-v1.17.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.16.0...@rotorsoft/act-tck-v1.17.0) (2026-06-27)


### Features

* **act:** resume with_snaps reads from the latest snapshot per stream ([959f4a8](https://github.com/rotorsoft/act-root/commit/959f4a89e8213f7e71a408bdb82b2863cbca2cdd))

# [@rotorsoft/act-tck-v1.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.15.1...@rotorsoft/act-tck-v1.16.0) (2026-06-24)


### Bug Fixes

* **act:** paginate close-cycle safety probe across all subscriptions ([719c41b](https://github.com/rotorsoft/act-root/commit/719c41b8e2815db800a1320c4d5e7acbef4e079f))


### Features

* **act:** bound the autoclose cycle with a paginated rolling sweep ([4261a81](https://github.com/rotorsoft/act-root/commit/4261a81571ea5648486a17383d633df31ff6fed5))
* **act:** run autoclose as a low-frequency whole-store sweep with an off-hours window ([2df9755](https://github.com/rotorsoft/act-root/commit/2df9755abb28486d3f0187826e8bad1ee37bf5ad))

# [@rotorsoft/act-tck-v1.15.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.15.0...@rotorsoft/act-tck-v1.15.1) (2026-06-23)

# [@rotorsoft/act-tck-v1.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.14.0...@rotorsoft/act-tck-v1.15.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-tck-v1.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.3...@rotorsoft/act-tck-v1.14.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-tck-v1.13.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.2...@rotorsoft/act-tck-v1.13.3) (2026-06-20)


### Bug Fixes

* **act-sse:** re-export @rotorsoft/act-http/sse instead of duplicating it ([26ab476](https://github.com/rotorsoft/act-root/commit/26ab4760c6cabcfa6092569bb7bedecae9d33dd7)), closes [#981](https://github.com/rotorsoft/act-root/issues/981)

# [@rotorsoft/act-tck-v1.13.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.1...@rotorsoft/act-tck-v1.13.2) (2026-06-20)


### Bug Fixes

* **act-tck:** pin claim() lease semantics and align pg/sqlite adapters ([86f940e](https://github.com/rotorsoft/act-root/commit/86f940e14112afa9def0876878cfc3d46562ca7b)), closes [#980](https://github.com/rotorsoft/act-root/issues/980)

# [@rotorsoft/act-tck-v1.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.13.0...@rotorsoft/act-tck-v1.13.1) (2026-06-20)


### Bug Fixes

* **act:** throw on duplicate reaction/projection handler names ([974b6fd](https://github.com/rotorsoft/act-root/commit/974b6fda59f1f97374d4493cea87aa93e0c3a28e)), closes [#979](https://github.com/rotorsoft/act-root/issues/979)

# [@rotorsoft/act-tck-v1.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.12.0...@rotorsoft/act-tck-v1.13.0) (2026-06-13)


### Features

* **act:** [#838](https://github.com/rotorsoft/act-root/issues/838) — \`when({...})\` close-policy factory ([1404912](https://github.com/rotorsoft/act-root/commit/14049128a45291a337496135191e2251114d2b77)), closes [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)

# [@rotorsoft/act-tck-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.11.0...@rotorsoft/act-tck-v1.12.0) (2026-06-11)


### Features

* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — .autocloses + .archives state-builder declarators (slice 1 / 4) ([b4c7bab](https://github.com/rotorsoft/act-root/commit/b4c7bab57f1d257c16117311554850b473dac7b3)), closes [#802](https://github.com/rotorsoft/act-root/issues/802) [#838](https://github.com/rotorsoft/act-root/issues/838) [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)
* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — AutocloseController wired into the orchestrator (slice 3 / 4) ([bebc2b9](https://github.com/rotorsoft/act-root/commit/bebc2b9a3bddf389e487d00d3140bec3039745a6)), closes [#802](https://github.com/rotorsoft/act-root/issues/802)

# [@rotorsoft/act-tck-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.10.0...@rotorsoft/act-tck-v1.11.0) (2026-06-11)


### Features

* **act-http:** [#846](https://github.com/rotorsoft/act-root/issues/846) — generated SSE subscriptions on trpc + hono ([142955d](https://github.com/rotorsoft/act-root/commit/142955ddb93b750ff705b9b1a0a20bfe23b6d126)), closes [#835](https://github.com/rotorsoft/act-root/issues/835)

# [@rotorsoft/act-tck-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.9.0...@rotorsoft/act-tck-v1.10.0) (2026-06-11)


### Features

* **server:** [#847](https://github.com/rotorsoft/act-root/issues/847) — multi-transport calculator demo (trpc + hono rest + openapi) ([8e959a7](https://github.com/rotorsoft/act-root/commit/8e959a75732bc44e2c58c40d3f17e83ffb8d2f9c))

# [@rotorsoft/act-tck-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.8.0...@rotorsoft/act-tck-v1.9.0) (2026-06-11)


### Features

* **act-http:** [#845](https://github.com/rotorsoft/act-root/issues/845) — @rotorsoft/act-http/openapi subpath emits OpenAPI 3.1 documents ([6398c16](https://github.com/rotorsoft/act-root/commit/6398c1636ed893d30f8901caa89f1d8a2d4db61d))

# [@rotorsoft/act-tck-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.7.0...@rotorsoft/act-tck-v1.8.0) (2026-06-11)


### Features

* **act-http:** [#844](https://github.com/rotorsoft/act-root/issues/844) — @rotorsoft/act-http/hono subpath generates a typed REST surface ([3a5274c](https://github.com/rotorsoft/act-root/commit/3a5274cb15255f747f5a988d1755a6892d142652))

# [@rotorsoft/act-tck-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.6.0...@rotorsoft/act-tck-v1.7.0) (2026-06-11)


### Features

* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — @rotorsoft/act-http/trpc subpath generates a typed tRPC router ([1d29e55](https://github.com/rotorsoft/act-root/commit/1d29e55582982c2e2c344ff473553cbc4690bba2)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845) [#847](https://github.com/rotorsoft/act-root/issues/847)
* **act-http:** [#843](https://github.com/rotorsoft/act-root/issues/843) — TrpcOptions.expectedVersion threads optimistic concurrency ([d05a3bc](https://github.com/rotorsoft/act-root/commit/d05a3bca8440ce25d73860c53573684eabd41e11)), closes [#844](https://github.com/rotorsoft/act-root/issues/844) [#845](https://github.com/rotorsoft/act-root/issues/845)

# [@rotorsoft/act-tck-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.4...@rotorsoft/act-tck-v1.6.0) (2026-06-10)


### Features

* **act-pg,act-sqlite:** [#921](https://github.com/rotorsoft/act-root/issues/921) — adapter-layer PII column encryption via @rotorsoft/act-crypto ([e0b1109](https://github.com/rotorsoft/act-root/commit/e0b11099a4fe2f333f3a2b045df1cf6728854e71))

# [@rotorsoft/act-tck-v1.5.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.3...@rotorsoft/act-tck-v1.5.4) (2026-06-09)

# [@rotorsoft/act-tck-v1.5.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.2...@rotorsoft/act-tck-v1.5.3) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.1...@rotorsoft/act-tck-v1.5.2) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.5.0...@rotorsoft/act-tck-v1.5.1) (2026-06-07)

# [@rotorsoft/act-tck-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.4.0...@rotorsoft/act-tck-v1.5.0) (2026-06-04)


### Features

* **act:** pii_isolation Store contract — capability + forget_pii + TCK ([#868](https://github.com/rotorsoft/act-root/issues/868)) ([eced65c](https://github.com/rotorsoft/act-root/commit/eced65c4777547edd9876253fca1e8f92c75a950)), closes [#566](https://github.com/rotorsoft/act-root/issues/566) [#855](https://github.com/rotorsoft/act-root/issues/855) [870/#871](https://github.com/rotorsoft/act-root/issues/871)

# [@rotorsoft/act-tck-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.3.0...@rotorsoft/act-tck-v1.4.0) (2026-05-30)


### Features

* **inspector:** restore wizard, csv viewer, dry-run preview modal ([3809025](https://github.com/rotorsoft/act-root/commit/3809025f75e79846c23e2f8da49a1a68afdeb8d1)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)

# [@rotorsoft/act-tck-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.2.0...@rotorsoft/act-tck-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)

# [@rotorsoft/act-tck-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.1.0...@rotorsoft/act-tck-v1.2.0) (2026-05-26)


### Features

* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-tck-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.0.0...@rotorsoft/act-tck-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-tck-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.4.0...@rotorsoft/act-tck-v1.0.0) (2026-05-21)


* chore(act-tck)!: enter 1.0 stability commitment ([ff7a0dc](https://github.com/rotorsoft/act-root/commit/ff7a0dc17b10d2a5be660fd66ee3c19930c43a6c)), closes [#774](https://github.com/rotorsoft/act-root/issues/774) [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-tck. The
kit's published surface — `runStoreTck`, `runCacheTck`,
`runLoggerTck`, the `Capabilities` types, and the fixture helpers —
is now covered by SemVer per STABILITY.md, alongside the
Store/Cache/Logger contracts the TCK validates. Breaking changes
require a major bump and a written migration note.

# [@rotorsoft/act-tck-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.3.0...@rotorsoft/act-tck-v0.4.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))

# [@rotorsoft/act-tck-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.3.0...@rotorsoft/act-tck-v0.4.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))

# [@rotorsoft/act-tck-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.2.0...@rotorsoft/act-tck-v0.3.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-tck-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.1.0...@rotorsoft/act-tck-v0.2.0) (2026-05-16)


### Features

* **act:** add app.unblock for poison-message recovery ([0374df8](https://github.com/rotorsoft/act-root/commit/0374df897143ead2d9b0251e973e24249bc29db7))
* **act:** reset and unblock accept string[] or StreamFilter; add app.blocked_streams ([1cd4e98](https://github.com/rotorsoft/act-root/commit/1cd4e9889c0dd934b81fdfb660c5d8cf4cc96803))


### BREAKING CHANGES

* **act:** for adapters that don't implement it yet; capability-
gated in the TCK). Implemented across all three in-tree adapters:

- InMemoryStore: new InMemoryStream.unblock() that flips _blocked and
  returns whether the stream was actually flipped.
- PostgresStore: single UPDATE with WHERE blocked = true so rowCount
  reflects only streams that flipped.
- SqliteStore: transactional UPDATE per stream, mirrors the PG semantics.

All three set retry = -1 (matching the InMemoryStore convention) so the
first post-unblock claim returns retry = 0 ("first attempt"). Storing 0
would make claim's post-bump return 1, mis-reporting the post-recovery
attempt as a continuation of the failed sequence.

Adds Act.unblock(streams) that wraps store().unblock() and arms the
orchestrator's drain flag so a settled app picks up the now-free streams
on the next cycle. Symmetric with the existing Act.reset() wrapper.

TCK: new "unblock" describe block with four cases — happy path
(blocked → unblock → claim resumes at preserved watermark, retry = 0),
no-op on unblocked stream, no-op on unknown/empty, mixed input counts
only the actually-blocked streams.

Integration test in non-retryable.spec.ts exercises the full
NonRetryableError → block → unblock → reprocess flow: handler throws
permanent error, drain blocks immediately, app.unblock(streams) clears
the flag, next drain succeeds at the SAME event (not replayed from
zero).

Docs:
- docs/concepts/error-handling.md gains an "unblock" subsection
  contrasting it with reset.
- docs/architecture/concurrency-model.md's "block" exit description
  updated to mention NonRetryableError and the unblock/reset choice.
- docs/guides/production-checklist.md changes the recovery instruction
  from "Unblock with app.reset" to "recover with app.unblock; reset is
  for rebuilds."
- libs/act-http/README.md adds a "Recovering a blocked stream"
  subsection — important because 4xx blocks are now the common case
  and reset would re-fire all historical webhooks.
- book/act-604-non-retryable.md gains a section on the recovery
  primitive, including the retry = -1 convention rationale.

Tests: 1556 passed (3 new unblock tests in TCK, 2 new in non-retryable
spec). Coverage 99.95% branches globally — drops from 100% are in
defensive error paths (rowCount ?? 0, rollback) that mirror the
existing untested paths in reset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# [@rotorsoft/act-tck-v0.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v0.0.0...@rotorsoft/act-tck-v0.1.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))
* **act-tck:** re-export Store/Cache/Logger port types ([f23f535](https://github.com/rotorsoft/act-root/commit/f23f53532ebcf03db48d8a1c7e13887c13491833)), closes [#716](https://github.com/rotorsoft/act-root/issues/716)
