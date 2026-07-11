# [@rotorsoft/act-v1.22.9](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.8...@rotorsoft/act-v1.22.9) (2026-07-11)


### Bug Fixes

* **act:** floor correlate cold-start checkpoint below the watermark ([4d3eb30](https://github.com/rotorsoft/act-root/commit/4d3eb30456a09f208cf752308997276d7aa8b1bc)), closes [#1207](https://github.com/rotorsoft/act-root/issues/1207)
* **act:** fold TOCTOU frontier, load cache-error, expectedVersion retry ([611c425](https://github.com/rotorsoft/act-root/commit/611c425c1c20de62adc4b761b7026498835a4c16)), closes [#1204](https://github.com/rotorsoft/act-root/issues/1204) [#1206](https://github.com/rotorsoft/act-root/issues/1206) [#1208](https://github.com/rotorsoft/act-root/issues/1208)
* **act:** re-arm settle wake-ups requested during a running cycle ([8876082](https://github.com/rotorsoft/act-root/commit/887608240d5be14616e6c7e067b6065103eff1ef)), closes [#1205](https://github.com/rotorsoft/act-root/issues/1205)

# [@rotorsoft/act-v1.22.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.7...@rotorsoft/act-v1.22.8) (2026-07-11)


### Bug Fixes

* **act-pg:** per-pool jsonb parser, names:[]/before guards, TCK + docs (ACT-1198/1199) ([1043227](https://github.com/rotorsoft/act-root/commit/10432274edc0ce583563d0902056fd6d6ed7955c)), closes [#1197](https://github.com/rotorsoft/act-root/issues/1197) [#1199](https://github.com/rotorsoft/act-root/issues/1199)
* **act:** honor names:[] and falsy-zero before/after in query (ACT-1199) ([c78e57b](https://github.com/rotorsoft/act-root/commit/c78e57b04a71326d47c39a77263aecfa2fbdf27a))

# [@rotorsoft/act-v1.22.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.6...@rotorsoft/act-v1.22.7) (2026-07-11)


### Bug Fixes

* **act-http:** mark sensitive() action-input fields in the openapi request schema ([#1228](https://github.com/rotorsoft/act-root/issues/1228)) ([003eea2](https://github.com/rotorsoft/act-root/commit/003eea2bfd97c35641ee585a0a26cab40fa1c564))
* **act:** orphaned-lane advisory, defer durability across restart, audit lane universe ([1dee16d](https://github.com/rotorsoft/act-root/commit/1dee16d09f4aab2efaef5447ca6c7d924419dd8c))

# [@rotorsoft/act-v1.22.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.5...@rotorsoft/act-v1.22.6) (2026-07-11)


### Bug Fixes

* **act:** open autoclose window at the DST spring-forward gap instant ([acf00f3](https://github.com/rotorsoft/act-root/commit/acf00f3308a75cca6f742530a6a95eb373ecf599))
* **act:** reject leading-zero event versions that collide with the canonical form ([4089364](https://github.com/rotorsoft/act-root/commit/4089364d710c12689f486a0cb511272b680d6434))

# [@rotorsoft/act-v1.22.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.4...@rotorsoft/act-v1.22.5) (2026-07-11)


### Bug Fixes

* **act:** restore regex claim sources with a literal fast-path ([3abd00d](https://github.com/rotorsoft/act-root/commit/3abd00d53848948aa0d7a59a4884a47a0e6000eb)), closes [#1215](https://github.com/rotorsoft/act-root/issues/1215) [#1215](https://github.com/rotorsoft/act-root/issues/1215)

# [@rotorsoft/act-v1.22.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.3...@rotorsoft/act-v1.22.4) (2026-07-10)


### Bug Fixes

* **act:** close-guard cache poisoning, scoped-port leaks, restore migration remap ([8883b50](https://github.com/rotorsoft/act-root/commit/8883b50758e004ef86086f56dfb3db71e2185702)), closes [#1188](https://github.com/rotorsoft/act-root/issues/1188) [#1191](https://github.com/rotorsoft/act-root/issues/1191) [#1188](https://github.com/rotorsoft/act-root/issues/1188) [#1191](https://github.com/rotorsoft/act-root/issues/1191) [#1192](https://github.com/rotorsoft/act-root/issues/1192)

# [@rotorsoft/act-v1.22.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.2...@rotorsoft/act-v1.22.3) (2026-07-10)


### Bug Fixes

* **act:** treat claim sources as exact stream names in the in-memory store ([bd0c980](https://github.com/rotorsoft/act-root/commit/bd0c980cb69e3befad0fa2afd34674f4a6d9d168))

# [@rotorsoft/act-v1.22.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.1...@rotorsoft/act-v1.22.2) (2026-07-10)


### Bug Fixes

* **act:** type the reaction-scoped iact and repair invariant doc examples ([239137b](https://github.com/rotorsoft/act-root/commit/239137b4668c887a3724d97cc1ea40e1bafe22d1)), closes [#1185](https://github.com/rotorsoft/act-root/issues/1185)

# [@rotorsoft/act-v1.22.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.22.0...@rotorsoft/act-v1.22.1) (2026-07-10)


### Bug Fixes

* **act:** never ack past an event with an unhandled reaction ([853071e](https://github.com/rotorsoft/act-root/commit/853071ed5afc6b64bb16bf54aa65b8d986be9195)), closes [#1179](https://github.com/rotorsoft/act-root/issues/1179)

# [@rotorsoft/act-v1.22.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.21.0...@rotorsoft/act-v1.22.0) (2026-07-10)


### Features

* **act:** derive the off-window autoclose re-check from the window itself ([4fc9adc](https://github.com/rotorsoft/act-root/commit/4fc9adc7defe9fa1ad868c9e37e8f9677aa80642)), closes [#1090](https://github.com/rotorsoft/act-root/issues/1090) [#1175](https://github.com/rotorsoft/act-root/issues/1175)

# [@rotorsoft/act-v1.21.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.20.0...@rotorsoft/act-v1.21.0) (2026-07-10)


### Features

* **act:** close the books on a rolling window ([b20c2fd](https://github.com/rotorsoft/act-root/commit/b20c2fdec9fb37f8f64514c7b7412bd368d26358)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)
* **act:** windowed truncate boundary on the store port ([4bf94bf](https://github.com/rotorsoft/act-root/commit/4bf94bf42bac0b40306f1ab379dea66ebb6404ca)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)

# [@rotorsoft/act-v1.20.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.19.0...@rotorsoft/act-v1.20.0) (2026-07-08)


### Bug Fixes

* **act:** cache and snapshot writes never lie about their frontier ([ef73607](https://github.com/rotorsoft/act-root/commit/ef736076b473716a6cafbebd45c73cdbdffe1cb3)), closes [#1169](https://github.com/rotorsoft/act-root/issues/1169)


### Features

* **act:** .of() resolves the registry-merged full state at build ([d9dfa3d](https://github.com/rotorsoft/act-root/commit/d9dfa3d8793c83c25aabeef4a923600ea4589b43))

# [@rotorsoft/act-v1.19.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.8...@rotorsoft/act-v1.19.0) (2026-07-08)


### Features

* **act:** state projections — projection(name).of(state).flush(handler) ([a5ef582](https://github.com/rotorsoft/act-root/commit/a5ef5827a5e64049f369883e6326790f46d71208)), closes [#1125](https://github.com/rotorsoft/act-root/issues/1125)

# [@rotorsoft/act-v1.18.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.7...@rotorsoft/act-v1.18.8) (2026-07-06)


### Bug Fixes

* **deps:** update non-major dependencies ([8df28a7](https://github.com/rotorsoft/act-root/commit/8df28a79caea4df01850dc1a5e9d14e806e5cdeb))

# [@rotorsoft/act-v1.18.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.6...@rotorsoft/act-v1.18.7) (2026-07-06)


### Bug Fixes

* **deps:** update non-major dependencies ([#1156](https://github.com/rotorsoft/act-root/issues/1156)) ([b460cdc](https://github.com/rotorsoft/act-root/commit/b460cdcdb64dc6c5c1f538a0fe955a19aabce145))

# [@rotorsoft/act-v1.18.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.5...@rotorsoft/act-v1.18.6) (2026-07-06)

# [@rotorsoft/act-v1.18.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.4...@rotorsoft/act-v1.18.5) (2026-07-05)


### Bug Fixes

* **act:** correlate arms lane controllers for newly-subscribed streams ([9a23d4c](https://github.com/rotorsoft/act-root/commit/9a23d4c2968623a9581c6efe8facb7571167ced6))

# [@rotorsoft/act-v1.18.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.3...@rotorsoft/act-v1.18.4) (2026-07-05)


### Bug Fixes

* **act:** externalize vitest from the test subpath bundle ([120f50a](https://github.com/rotorsoft/act-root/commit/120f50ab2526798325bfcab8e7ea3a9fe664a9a0))

# [@rotorsoft/act-v1.18.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.2...@rotorsoft/act-v1.18.3) (2026-07-05)


### Bug Fixes

* **act:** failed defer persist never stalls recurrence or drops cycle outcomes ([42a4473](https://github.com/rotorsoft/act-root/commit/42a4473d2049a3fbf3fe8bb9ff6f9125b087f258)), closes [#1124](https://github.com/rotorsoft/act-root/issues/1124)
* **act:** finalize drain cycles atomically — acks and defer schedules in one store call ([9ab2f26](https://github.com/rotorsoft/act-root/commit/9ab2f26e13999b1f8717984cd5bc088b919969e6))

# [@rotorsoft/act-v1.18.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.1...@rotorsoft/act-v1.18.2) (2026-07-04)


### Bug Fixes

* **act-sqlite:** throw on non-portable stream filter patterns ([#1114](https://github.com/rotorsoft/act-root/issues/1114)) ([14dad8b](https://github.com/rotorsoft/act-root/commit/14dad8be006d25badef426246a6ea1a2126fb5e4))
* **act:** surface warn-level signal when snapshot write fails ([#1115](https://github.com/rotorsoft/act-root/issues/1115)) ([b221ab1](https://github.com/rotorsoft/act-root/commit/b221ab1290ffdc2d1ddd1c5ddae3684f90982da2))

# [@rotorsoft/act-v1.18.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.18.0...@rotorsoft/act-v1.18.1) (2026-07-04)

# [@rotorsoft/act-v1.18.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.17.0...@rotorsoft/act-v1.18.0) (2026-07-03)


### Features

* **act:** declarative .defer(when) builder step (slice 2, [#1091](https://github.com/rotorsoft/act-root/issues/1091)) ([50e59c3](https://github.com/rotorsoft/act-root/commit/50e59c390fc5fae42d3ebc52b81f5eee29348bdf))
* **act:** public DeferSignal throw for imperative defer (slice 2, [#1091](https://github.com/rotorsoft/act-root/issues/1091)) ([7280560](https://github.com/rotorsoft/act-root/commit/7280560b8c212478bd02f6ab6c2696478fad012d))

# [@rotorsoft/act-v1.17.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.16.1...@rotorsoft/act-v1.17.0) (2026-07-01)


### Bug Fixes

* **act:** run autoclose on a synthetic stream; clamp long defer timers ([#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([d93bfbb](https://github.com/rotorsoft/act-root/commit/d93bfbb67d1ec4ef4245bbc642fdce22c6d0c07e))


### Features

* **act:** add persisted defer outcome + Store.defer (slice 1a-1c, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([c5c46ce](https://github.com/rotorsoft/act-root/commit/c5c46cef7a03c2853434b9e289315d91d2165c59))
* **act:** close-from-reaction mechanic via CloseSignal (slice 1d part 1, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([eb68839](https://github.com/rotorsoft/act-root/commit/eb68839e267966fe211b90a8fd7b850273544873))
* **act:** port autocloses to a synthesized defer/close reaction (slice 1d part 2, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([832844a](https://github.com/rotorsoft/act-root/commit/832844a1dffb3ec28fe426de1e1de4c0af8c7267))

# [@rotorsoft/act-v1.16.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.16.0...@rotorsoft/act-v1.16.1) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-v1.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.15.0...@rotorsoft/act-v1.16.0) (2026-06-27)


### Features

* **act:** resume with_snaps reads from the latest snapshot per stream ([959f4a8](https://github.com/rotorsoft/act-root/commit/959f4a89e8213f7e71a408bdb82b2863cbca2cdd))

# [@rotorsoft/act-v1.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.14.1...@rotorsoft/act-v1.15.0) (2026-06-24)


### Bug Fixes

* **act:** paginate close-cycle safety probe across all subscriptions ([719c41b](https://github.com/rotorsoft/act-root/commit/719c41b8e2815db800a1320c4d5e7acbef4e079f))


### Features

* **act:** bound the autoclose cycle with a paginated rolling sweep ([4261a81](https://github.com/rotorsoft/act-root/commit/4261a81571ea5648486a17383d633df31ff6fed5))
* **act:** run autoclose as a low-frequency whole-store sweep with an off-hours window ([2df9755](https://github.com/rotorsoft/act-root/commit/2df9755abb28486d3f0187826e8bad1ee37bf5ad))

# [@rotorsoft/act-v1.14.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.14.0...@rotorsoft/act-v1.14.1) (2026-06-23)

# [@rotorsoft/act-v1.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.13.0...@rotorsoft/act-v1.14.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-v1.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.12.1...@rotorsoft/act-v1.13.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-v1.12.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.12.0...@rotorsoft/act-v1.12.1) (2026-06-20)


### Bug Fixes

* **act:** throw on duplicate reaction/projection handler names ([974b6fd](https://github.com/rotorsoft/act-root/commit/974b6fda59f1f97374d4493cea87aa93e0c3a28e)), closes [#979](https://github.com/rotorsoft/act-root/issues/979)

# [@rotorsoft/act-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.11.0...@rotorsoft/act-v1.12.0) (2026-06-13)


### Features

* **act:** [#838](https://github.com/rotorsoft/act-root/issues/838) — \`when({...})\` close-policy factory ([1404912](https://github.com/rotorsoft/act-root/commit/14049128a45291a337496135191e2251114d2b77)), closes [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)

# [@rotorsoft/act-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.10.2...@rotorsoft/act-v1.11.0) (2026-06-11)


### Features

* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — .autocloses + .archives state-builder declarators (slice 1 / 4) ([b4c7bab](https://github.com/rotorsoft/act-root/commit/b4c7bab57f1d257c16117311554850b473dac7b3)), closes [#802](https://github.com/rotorsoft/act-root/issues/802) [#838](https://github.com/rotorsoft/act-root/issues/838) [#839](https://github.com/rotorsoft/act-root/issues/839) [#840](https://github.com/rotorsoft/act-root/issues/840)
* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — AutocloseController wired into the orchestrator (slice 3 / 4) ([bebc2b9](https://github.com/rotorsoft/act-root/commit/bebc2b9a3bddf389e487d00d3140bec3039745a6)), closes [#802](https://github.com/rotorsoft/act-root/issues/802)
* **act:** [#837](https://github.com/rotorsoft/act-root/issues/837) — run_autoclose_cycle pure function (slice 2 / 4) ([3498c47](https://github.com/rotorsoft/act-root/commit/3498c47e83bbc4329ca2916e5a6fd11232a54583)), closes [#802](https://github.com/rotorsoft/act-root/issues/802)

# [@rotorsoft/act-v1.10.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.10.1...@rotorsoft/act-v1.10.2) (2026-06-09)

# [@rotorsoft/act-v1.10.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.10.0...@rotorsoft/act-v1.10.1) (2026-06-07)

# [@rotorsoft/act-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.9.0...@rotorsoft/act-v1.10.0) (2026-06-06)


### Features

* **act:** .discloses() + registry sensitive_fields/disclosure_predicate ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 2) ([90bc8eb](https://github.com/rotorsoft/act-root/commit/90bc8ebdca22e7d2c02fe8b965afac853a912648))
* **act:** app.forget(stream) + forgotten lifecycle event ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 7) ([ba3ba5a](https://github.com/rotorsoft/act-root/commit/ba3ba5ac2bdc6291f3f69836ddc8d1563ac448c2)), closes [#868](https://github.com/rotorsoft/act-root/issues/868) [#869](https://github.com/rotorsoft/act-root/issues/869) [#882](https://github.com/rotorsoft/act-root/issues/882)
* **act:** build-time guard against sensitive states with snapshots ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 6) ([67ee1fa](https://github.com/rotorsoft/act-root/commit/67ee1fa3c7d49c5a1adc9f0d1e61e1b5e43ef216))
* **act:** commit-path pii split using sensitive_fields ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 3) ([0020ccc](https://github.com/rotorsoft/act-root/commit/0020ccc700410e967d52ef391392f2692de838a4)), closes [#868](https://github.com/rotorsoft/act-root/issues/868)
* **act:** read-path pii gate + REDACTED/SHREDDED sentinels ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 4) ([b2d9eec](https://github.com/rotorsoft/act-root/commit/b2d9eecbc0399da2070599fa337b885c60e2efee))
* **act:** sensitive() helper + field walker ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 1) ([1fe56fb](https://github.com/rotorsoft/act-root/commit/1fe56fb808b6df74a342d0cae4632a3c8e9c3d38)), closes [#566](https://github.com/rotorsoft/act-root/issues/566)
* **act:** strip pii from projection + reaction handlers ([#855](https://github.com/rotorsoft/act-root/issues/855) slice 5) ([b8ea48f](https://github.com/rotorsoft/act-root/commit/b8ea48f650518908431a6d3f886e9c217f1995c7))


### Performance Improvements

* **act:** measure [#855](https://github.com/rotorsoft/act-root/issues/855) orchestrator overhead — within noise on non-sensitive workloads ([b7bb39b](https://github.com/rotorsoft/act-root/commit/b7bb39bfc5b2c792d2ecfe8d08b470207dba319b))
* **act:** single-pass pii split — avoid spread + delete ([36a39ce](https://github.com/rotorsoft/act-root/commit/36a39ce8ed8e1e012deaa3c51bff1c5a92d15605))

# [@rotorsoft/act-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.8.0...@rotorsoft/act-v1.9.0) (2026-06-06)


### Features

* **act:** in-memory pii_isolation impl ([5400c61](https://github.com/rotorsoft/act-root/commit/5400c61779d131d3caa8bda7de0fe3d1fedbd2e0)), closes [#868](https://github.com/rotorsoft/act-root/issues/868) [#868](https://github.com/rotorsoft/act-root/issues/868) [#566](https://github.com/rotorsoft/act-root/issues/566) [#855](https://github.com/rotorsoft/act-root/issues/855) [#864](https://github.com/rotorsoft/act-root/issues/864) [#869](https://github.com/rotorsoft/act-root/issues/869)

# [@rotorsoft/act-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.7.0...@rotorsoft/act-v1.8.0) (2026-06-04)


### Features

* **act:** pii_isolation Store contract — capability + forget_pii + TCK ([#868](https://github.com/rotorsoft/act-root/issues/868)) ([eced65c](https://github.com/rotorsoft/act-root/commit/eced65c4777547edd9876253fca1e8f92c75a950)), closes [#566](https://github.com/rotorsoft/act-root/issues/566) [#855](https://github.com/rotorsoft/act-root/issues/855) [870/#871](https://github.com/rotorsoft/act-root/issues/871)

# [@rotorsoft/act-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.6.0...@rotorsoft/act-v1.7.0) (2026-06-02)


### Features

* **act:** per-action retry policy for ConcurrencyError ([5e45422](https://github.com/rotorsoft/act-root/commit/5e45422c77c7ca48c2c6baebe7dff4ca25cf6fca)), closes [#739](https://github.com/rotorsoft/act-root/issues/739)

# [@rotorsoft/act-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.5.2...@rotorsoft/act-v1.6.0) (2026-05-30)


### Features

* **act:** drop_closed_streams in scan (ACT-1126) ([7fbad5f](https://github.com/rotorsoft/act-root/commit/7fbad5f7f9b1db372b475e2374595af1dc160880))
* **act:** restore migration overlay — event_migrations + stream_rename ([816f2bc](https://github.com/rotorsoft/act-root/commit/816f2bc88873e9bde5ef61ff1dd216244b72a3d4)), closes [#785](https://github.com/rotorsoft/act-root/issues/785) [#790](https://github.com/rotorsoft/act-root/issues/790)
* **inspector:** restore wizard, csv viewer, dry-run preview modal ([3809025](https://github.com/rotorsoft/act-root/commit/3809025f75e79846c23e2f8da49a1a68afdeb8d1)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)

# [@rotorsoft/act-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.5.1...@rotorsoft/act-v1.5.2) (2026-05-30)


### Bug Fixes

* **docs:** silence remaining typedoc + docusaurus warnings ([2c3bf2f](https://github.com/rotorsoft/act-root/commit/2c3bf2f7e98b34ab94ad143fb4a7f900cefe38ee))

# [@rotorsoft/act-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.5.0...@rotorsoft/act-v1.5.1) (2026-05-30)


### Bug Fixes

* **docs:** docusaurus deploy — jsx flag + drop dead act-sse references ([ae68f30](https://github.com/rotorsoft/act-root/commit/ae68f30cea334cbe1514100bda3a8cfde6ea45ba)), closes [#823](https://github.com/rotorsoft/act-root/issues/823)

# [@rotorsoft/act-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.4.0...@rotorsoft/act-v1.5.0) (2026-05-30)


### Features

* **act:** listen and drain build options for non-reactive instances ([4d04225](https://github.com/rotorsoft/act-root/commit/4d042250bc794456e87323f5852a6d5f8d2c9cab))

# [@rotorsoft/act-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.3.0...@rotorsoft/act-v1.4.0) (2026-05-30)


### Features

* **act:** batch_size + max_id probe for determinate progress (ACT-1133) ([ab78103](https://github.com/rotorsoft/act-root/commit/ab78103cbc674918413752c531f5ccaee83ebe53))
* **act:** iterate paginates source.query for bounded-memory scan (ACT-1133) ([f97b103](https://github.com/rotorsoft/act-root/commit/f97b10343b7a47b08468ac9169e13db09c5a3f90)), closes [#817](https://github.com/rotorsoft/act-root/issues/817)

# [@rotorsoft/act-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.2.0...@rotorsoft/act-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)
* **inspector:** restore ui with dry-run preview, toggles, reactive progress ([67f9815](https://github.com/rotorsoft/act-root/commit/67f98153566626c04029f57a3efe3a579b480643)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)
* **inspector:** unify backup/restore/transfer into a single endpoint and dialog ([e00960c](https://github.com/rotorsoft/act-root/commit/e00960cf5f90220e8d8fce42c07c888ba2b3aefb))

# [@rotorsoft/act-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.1.0...@rotorsoft/act-v1.2.0) (2026-05-26)


### Features

* **act:** add dry_run flag to scanoptions for pre-flight restore validation ([60926a2](https://github.com/rotorsoft/act-root/commit/60926a29df5635750d2c057d60d56ccca95dac05))
* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v1.0.0...@rotorsoft/act-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.46.0...@rotorsoft/act-v1.0.0) (2026-05-21)


* chore(act)!: enter 1.0 stability commitment ([4d4e1de](https://github.com/rotorsoft/act-root/commit/4d4e1dec2ad8249f9e21b2be71e4124f6adda25f)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act. Per
STABILITY.md, the public API surfaces — the builder DSL (state, slice,
projection, act), the IAct runtime interface, the Store/Cache/Logger
adapter contracts, the lifecycle event names and payload shapes, and
the public type exports — are now covered by SemVer. Breaking changes
require a major bump and a written migration note.

# [@rotorsoft/act-v0.46.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.45.0...@rotorsoft/act-v0.46.0) (2026-05-21)


### Features

* **act:** app.audit() — schema + deprecated-load categories (slice 1) ([82803cb](https://github.com/rotorsoft/act-root/commit/82803cb68f92a18ae6367dda01a8eb82daabbc68)), closes [#723](https://github.com/rotorsoft/act-root/issues/723) [#723](https://github.com/rotorsoft/act-root/issues/723)
* **act:** audit close-candidate + restart-candidate (slice 2) ([6e9d710](https://github.com/rotorsoft/act-root/commit/6e9d710077060b3d78523f82f8e38e3d0b9ccf9c)), closes [#723](https://github.com/rotorsoft/act-root/issues/723)
* **act:** audit reaction-health + snapshot-drift (slice 3) ([604f149](https://github.com/rotorsoft/act-root/commit/604f149cd081e0d4c2d8a547cec364f7635cbe6f)), closes [#723](https://github.com/rotorsoft/act-root/issues/723)
* **act:** audit slice 4 — routing-health, correlation-gaps, ([d69ea3b](https://github.com/rotorsoft/act-root/commit/d69ea3bbe576e7e83f4c241709a08ce3aabe1701)), closes [#723](https://github.com/rotorsoft/act-root/issues/723)

# [@rotorsoft/act-v0.45.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.44.0...@rotorsoft/act-v0.45.0) (2026-05-19)


### Bug Fixes

* **act:** surface partial-success failures in drain trace + block records ([b4994d4](https://github.com/rotorsoft/act-root/commit/b4994d459ef6dc1221d23e9ca459f9434da644dc)), closes [#16](https://github.com/rotorsoft/act-root/issues/16)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** add lane-aware type surface for drain controllers ([7914eca](https://github.com/rotorsoft/act-root/commit/7914eca874baa71997fca1da0e0fdbbf4f5b613a))
* **act:** human-readable drain traces + lane suffix; lane on ack/block ([82fc17a](https://github.com/rotorsoft/act-root/commit/82fc17aea2f7eeef21be3ba1c387aac4591cd603)), closes [#id](https://github.com/rotorsoft/act-root/issues/id) [#id](https://github.com/rotorsoft/act-root/issues/id)
* **act:** narrow slice lane declarations at compile time ([2ab2246](https://github.com/rotorsoft/act-root/commit/2ab2246e38a44e9a567b1e967b94fe6837741b70))
* **act:** parallel lane drain + per-lane workers; PG benchmark headline ([f76bc31](https://github.com/rotorsoft/act-root/commit/f76bc3146b0943c71d57992c8b270c85ed5e4eb1))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))
* **act:** selective lane arming by event-name → lane map ([53943bd](https://github.com/rotorsoft/act-root/commit/53943bde0273c18c3e37005a05576297001133d1))
* **act:** wire lanes through InMemoryStore ([4c81d02](https://github.com/rotorsoft/act-root/commit/4c81d02afd09c99915a72147fabe180f64463c00)), closes [#733](https://github.com/rotorsoft/act-root/issues/733)


### Performance Improvements

* **act:** lane fan-out overhead bench + PERFORMANCE.md numbers ([11fb121](https://github.com/rotorsoft/act-root/commit/11fb121cfffd0da55973a4fa944899d3e31de203))

# [@rotorsoft/act-v0.45.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.44.0...@rotorsoft/act-v0.45.0) (2026-05-19)


### Bug Fixes

* **act:** surface partial-success failures in drain trace + block records ([b4994d4](https://github.com/rotorsoft/act-root/commit/b4994d459ef6dc1221d23e9ca459f9434da644dc)), closes [#16](https://github.com/rotorsoft/act-root/issues/16)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** add lane-aware type surface for drain controllers ([7914eca](https://github.com/rotorsoft/act-root/commit/7914eca874baa71997fca1da0e0fdbbf4f5b613a))
* **act:** human-readable drain traces + lane suffix; lane on ack/block ([82fc17a](https://github.com/rotorsoft/act-root/commit/82fc17aea2f7eeef21be3ba1c387aac4591cd603)), closes [#id](https://github.com/rotorsoft/act-root/issues/id) [#id](https://github.com/rotorsoft/act-root/issues/id)
* **act:** narrow slice lane declarations at compile time ([2ab2246](https://github.com/rotorsoft/act-root/commit/2ab2246e38a44e9a567b1e967b94fe6837741b70))
* **act:** parallel lane drain + per-lane workers; PG benchmark headline ([f76bc31](https://github.com/rotorsoft/act-root/commit/f76bc3146b0943c71d57992c8b270c85ed5e4eb1))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))
* **act:** selective lane arming by event-name → lane map ([53943bd](https://github.com/rotorsoft/act-root/commit/53943bde0273c18c3e37005a05576297001133d1))
* **act:** wire lanes through InMemoryStore ([4c81d02](https://github.com/rotorsoft/act-root/commit/4c81d02afd09c99915a72147fabe180f64463c00)), closes [#733](https://github.com/rotorsoft/act-root/issues/733)


### Performance Improvements

* **act:** lane fan-out overhead bench + PERFORMANCE.md numbers ([11fb121](https://github.com/rotorsoft/act-root/commit/11fb121cfffd0da55973a4fa944899d3e31de203))

# [@rotorsoft/act-v0.44.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.43.0...@rotorsoft/act-v0.44.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-v0.43.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.42.0...@rotorsoft/act-v0.43.0) (2026-05-16)


* feat(act)!: add non-retryable error class for handler-signaled block (ACT-604) ([09cdfe0](https://github.com/rotorsoft/act-root/commit/09cdfe0ca753690bea348993b043fa4f84b293a7))


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
* @rotorsoft/act-http WebhookError no longer carries a
'retryable' field. Callers checking err.retryable should switch to
'err instanceof NonRetryableWebhookError' (or 'instanceof
NonRetryableError' for the framework-general check). The package is at
0.1.0 with no external consumers.

Closes ACT-604.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

# [@rotorsoft/act-v0.42.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.41.0...@rotorsoft/act-v0.42.0) (2026-05-15)


### Features

* **act:** configurable correlation id generator (ACT-404) ([ad250c7](https://github.com/rotorsoft/act-root/commit/ad250c77105e7ffd61375b36d43fc03c3b577acb))

# [@rotorsoft/act-v0.41.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.40.0...@rotorsoft/act-v0.41.0) (2026-05-14)


### Features

* **act:** per-reaction retry backoff (ACT-601) ([49f18ba](https://github.com/rotorsoft/act-root/commit/49f18ba2bed9685b45a5dbd2c40caeeb0075ca2a))

# [@rotorsoft/act-v0.40.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.39.0...@rotorsoft/act-v0.40.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))

# [@rotorsoft/act-v0.39.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.38.0...@rotorsoft/act-v0.39.0) (2026-05-12)


### Features

* **act:** test helpers — sandbox + fixture for parallel-safe per-test isolation (ACT-503) ([ea38cf5](https://github.com/rotorsoft/act-root/commit/ea38cf5136417531f5cc46313e8c4a587221958e))

# [@rotorsoft/act-v0.38.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.37.0...@rotorsoft/act-v0.38.0) (2026-05-12)


### Features

* **act:** per-Act scoped ports via ActOptions.scoped (ACT-501) ([2042ad8](https://github.com/rotorsoft/act-root/commit/2042ad8414a6a2351d7f96fc99082c04c6fc2064))

# [@rotorsoft/act-v0.37.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.36.0...@rotorsoft/act-v0.37.0) (2026-05-12)


### Features

* **act:** auto-deprecate legacy event versions via _v<n> convention (ACT-403) ([7f6fca6](https://github.com/rotorsoft/act-root/commit/7f6fca6b4dbb9ab11b408ae8fc590b7a2dd09e36))

# [@rotorsoft/act-v0.36.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.35.2...@rotorsoft/act-v0.36.0) (2026-05-12)


### Features

* **act:** enforce reference identity for cross-slice event schemas (ACT-401) ([ae135db](https://github.com/rotorsoft/act-root/commit/ae135db52b9b82943791e8b5e7f3858af223bb42))

# [@rotorsoft/act-v0.35.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.35.1...@rotorsoft/act-v0.35.2) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-v0.35.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.35.0...@rotorsoft/act-v0.35.1) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))

# [@rotorsoft/act-v0.35.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.34.0...@rotorsoft/act-v0.35.0) (2026-05-10)


### Features

* **act-pg:** add PG single-process reaction latency bench (ACT-103) ([8554f57](https://github.com/rotorsoft/act-root/commit/8554f5782ef0b8905e39171e3711934a5960e03a))
* **act:** per-stream reaction priority lanes (ACT-102) ([c08f18a](https://github.com/rotorsoft/act-root/commit/c08f18a05bbf478c4e0128dbd175897bb18dd701))
* **act:** reaction latency bench + workspace bench unification (ACT-103) ([79d419d](https://github.com/rotorsoft/act-root/commit/79d419dbee73dc0fbda65599e4f687362471aecd))

# [@rotorsoft/act-v0.34.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.33.3...@rotorsoft/act-v0.34.0) (2026-05-10)


### Features

* **act:** add Store.notify hook for cross-process drain wakeup (ACT-101) ([f1f40cf](https://github.com/rotorsoft/act-root/commit/f1f40cf608ba107c88bd0a0144c49af2ece47fe7))

# [@rotorsoft/act-v0.33.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.33.2...@rotorsoft/act-v0.33.3) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-v0.33.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.33.1...@rotorsoft/act-v0.33.2) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-v0.33.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.33.0...@rotorsoft/act-v0.33.1) (2026-05-04)


### Bug Fixes

* **act:** populate cache on load() so read-heavy paths are warm ([da8bb33](https://github.com/rotorsoft/act-root/commit/da8bb33afddc0de1a904f6564b390de38ecce964))

# [@rotorsoft/act-v0.33.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.7...@rotorsoft/act-v0.33.0) (2026-05-04)


### Features

* **act:** expose cache_hit + replayed + version on Snapshot, surface in load trace ([bbf5ff2](https://github.com/rotorsoft/act-root/commit/bbf5ff2580a895baec542ebc975120319997b72d))
* **act:** expose settle debounce default via ActOptions.settleDebounceMs ([f58bd03](https://github.com/rotorsoft/act-root/commit/f58bd03de998dc5b94c002745d90c2e6bab80113))

# [@rotorsoft/act-v0.32.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.6...@rotorsoft/act-v0.32.7) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-v0.32.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.5...@rotorsoft/act-v0.32.6) (2026-05-04)


### Bug Fixes

* **act:** drop payloads from ConcurrencyError message ([4dfabd8](https://github.com/rotorsoft/act-root/commit/4dfabd8d845ffa283e51f1bcd231be58cec53aee))
* **act:** guard ConsoleLogger json mode against cyclic payloads ([034d61f](https://github.com/rotorsoft/act-root/commit/034d61fd67376f44b75f3ec109127b7b4750b3a4))


### Performance Improvements

* **act:** index streams for O(1) commit and O(streams) claim in InMemoryStore ([aedae51](https://github.com/rotorsoft/act-root/commit/aedae51aa98c3d87992ef10a633cd01d70fb9968))

# [@rotorsoft/act-v0.32.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.4...@rotorsoft/act-v0.32.5) (2026-05-03)

# [@rotorsoft/act-v0.32.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.3...@rotorsoft/act-v0.32.4) (2026-05-03)


### Performance Improvements

* **act:** dedupe static reaction targets at build time ([3e15798](https://github.com/rotorsoft/act-root/commit/3e157981fb79c873b41af50167283e02526f3608))
* **act:** index drain fetched results by stream once instead of O(L*F) ([b8b842a](https://github.com/rotorsoft/act-root/commit/b8b842a9edc25fd4c38bb6b44b02d81266b33bad))
* **act:** memoize config() result on first call ([3b894f7](https://github.com/rotorsoft/act-root/commit/3b894f7801b08ff30f059b06caa97ab47e9a83ca))
* **act:** pre-bind scoped IAct methods once on the Act instance ([9812816](https://github.com/rotorsoft/act-root/commit/9812816e4efd9edc402edb722fed6c11d7a717a2))

# [@rotorsoft/act-v0.32.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.2...@rotorsoft/act-v0.32.3) (2026-05-03)


### Bug Fixes

* **act:** detect ZodError by instanceof instead of name string ([22c155f](https://github.com/rotorsoft/act-root/commit/22c155f6216151292b8a04e721537ab204e65d0c))
* **act:** pass radix 10 to parseInt for SLEEP_MS ([e1973ff](https://github.com/rotorsoft/act-root/commit/e1973ff26a0aa93db700ba7f9a45b40c3f7247e0))
* **act:** pick the right owning state per stream when seeding close() restart ([b7771cb](https://github.com/rotorsoft/act-root/commit/b7771cbe80c42ac6032eec98f5a5019013cbd2b5))
* **act:** resolve logger lazily in signals to allow user injection ([9237ee6](https://github.com/rotorsoft/act-root/commit/9237ee645974cf5461c22c8bb432fcc31d5d4329))
* **act:** run disposers and adapters serially in reverse order ([4e191bb](https://github.com/rotorsoft/act-root/commit/4e191bb8f0843811e77c36b702512745be04acee))
* **act:** stop mutating target object in extend() ([9beb2c5](https://github.com/rotorsoft/act-root/commit/9beb2c55a680ae994d7e58bd894a3cdd12baaf34))
* **act:** throw on duplicate batch handlers for the same projection target ([b25fd4e](https://github.com/rotorsoft/act-root/commit/b25fd4e2d3b605063902de80352dd8bb2d14ab1a))
* **act:** use query_streams for close() pending probe instead of claim+ack ([ee250b1](https://github.com/rotorsoft/act-root/commit/ee250b1057dbce790b6448b5babce36072db65bc))

# [@rotorsoft/act-v0.32.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.1...@rotorsoft/act-v0.32.2) (2026-05-03)

# [@rotorsoft/act-v0.32.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.32.0...@rotorsoft/act-v0.32.1) (2026-05-02)

# [@rotorsoft/act-v0.32.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.31.1...@rotorsoft/act-v0.32.0) (2026-05-02)


### Features

* **act:** add browser-safe ./types subpath export ([1a0d621](https://github.com/rotorsoft/act-root/commit/1a0d62151a22d717e68da003da453558afc9e187)), closes [#628](https://github.com/rotorsoft/act-root/issues/628)

# [@rotorsoft/act-v0.31.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.31.0...@rotorsoft/act-v0.31.1) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-v0.31.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.30.1...@rotorsoft/act-v0.31.0) (2026-04-27)


### Features

* **act:** add Store.query_streams for subscription introspection ([508c724](https://github.com/rotorsoft/act-root/commit/508c724a4176750dea5d9356e2e8290496331e61))

# [@rotorsoft/act-v0.30.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.30.0...@rotorsoft/act-v0.30.1) (2026-04-26)


### Bug Fixes

* **act:** arm drain flag on reset so settled apps replay ([290fdbc](https://github.com/rotorsoft/act-root/commit/290fdbc4bfbbbda0e4fda9114496bd3e42c771d7))
* **act:** settle drains to completion by default ([6aa4659](https://github.com/rotorsoft/act-root/commit/6aa46599b8c2fcfa880a599e9605ea3e961c30b5))

# [@rotorsoft/act-v0.30.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.29.1...@rotorsoft/act-v0.30.0) (2026-04-16)


### Features

* **act:** auto-inject reactingTo in reaction handlers ([0caa4f9](https://github.com/rotorsoft/act-root/commit/0caa4f9cebbb5d287bf59f43f4e3d5002dfb9ad6)), closes [#587](https://github.com/rotorsoft/act-root/issues/587)

# [@rotorsoft/act-v0.29.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.29.0...@rotorsoft/act-v0.29.1) (2026-04-15)

# [@rotorsoft/act-v0.29.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.28.0...@rotorsoft/act-v0.29.0) (2026-04-13)


### Bug Fixes

* **act:** pass proper meta from close() to store.truncate() ([2dbd31a](https://github.com/rotorsoft/act-root/commit/2dbd31a50eac4189f3b011fabf9030db7d704c14))
* **act:** proper meta traceability for close() events ([a9511f7](https://github.com/rotorsoft/act-root/commit/a9511f75c01a88df519323ab49737a56b0a28862))
* **act:** truncate returns committed seeds for correct cache warming ([f42fb94](https://github.com/rotorsoft/act-root/commit/f42fb9421ed9a0808baf14bec797631729477e44))
* **act:** use Schema and EventMeta types in truncate implementations ([6c958a6](https://github.com/rotorsoft/act-root/commit/6c958a66b1dd15aa84750e20df976ff0bdbc8407))


### Features

* **act:** add close-the-books stream archival and truncation ([30d6587](https://github.com/rotorsoft/act-root/commit/30d6587c903022da5d0f10fa3b7b90521c2d60ce)), closes [#562](https://github.com/rotorsoft/act-root/issues/562)
* **act:** atomic guard-first close with truncate+seed transaction ([034e20a](https://github.com/rotorsoft/act-root/commit/034e20a5b2ee037cdd90af3531bf03c7115ebbd5))


### Performance Improvements

* **act:** eliminate redundant store operations in close() ([1f900c6](https://github.com/rotorsoft/act-root/commit/1f900c692593311bdb3b699db5c373020c9766d0))
* **act:** optimize close() to minimize store round-trips ([d89b7f5](https://github.com/rotorsoft/act-root/commit/d89b7f5ad30256152d98824c94c42cfdf3bc1307))
* **act:** parallelize close() operations ([8af1437](https://github.com/rotorsoft/act-root/commit/8af1437fbe503b7a3673381e352d0e8b3c4811dd))


### Reverts

* remove truncate(before) parameter — not needed ([24d297b](https://github.com/rotorsoft/act-root/commit/24d297b26cf364ccbd541bc911ee8a7227fb4e15))

# [@rotorsoft/act-v0.28.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.27.0...@rotorsoft/act-v0.28.0) (2026-04-12)


### Features

* **act:** add query options to load() for time-travel ([ce487b4](https://github.com/rotorsoft/act-root/commit/ce487b40be0a18ca4996a48a2ca14ade86993c0a)), closes [#565](https://github.com/rotorsoft/act-root/issues/565)

# [@rotorsoft/act-v0.27.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.26.1...@rotorsoft/act-v0.27.0) (2026-04-11)


### Features

* **act, act-pg:** add Store.reset() for projection rebuild ([66fa95a](https://github.com/rotorsoft/act-root/commit/66fa95ac63e03da4da472f14cc3776c1f09b1826)), closes [#564](https://github.com/rotorsoft/act-root/issues/564)

# [@rotorsoft/act-v0.26.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.26.0...@rotorsoft/act-v0.26.1) (2026-04-09)


### Bug Fixes

* **act:** harden framework with correctness and safety fixes ([7b6406a](https://github.com/rotorsoft/act-root/commit/7b6406aa5e7179e4d0a7bf3e91829670dd51226b))

# [@rotorsoft/act-v0.26.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.25.2...@rotorsoft/act-v0.26.0) (2026-04-08)


### Bug Fixes

* **act:** fix causation type in bench file ([dae55a8](https://github.com/rotorsoft/act-root/commit/dae55a8ab7d3f138af876dadbb011e6109dc2cf0))
* **act:** revert version bump — managed by semantic-release ([04c8bb5](https://github.com/rotorsoft/act-root/commit/04c8bb5f6d8bdfb80d29bf5b8c815c579c6442e0))


### Features

* **act:** batched projection replay for high-throughput event processing ([4157c7d](https://github.com/rotorsoft/act-root/commit/4157c7dfc49461604e2ea51e03189caf99238edc)), closes [hi#throughput](https://github.com/hi/issues/throughput) [#556](https://github.com/rotorsoft/act-root/issues/556)


### Performance Improvements

* **act:** add PostgreSQL batch projection benchmark — 20x speedup ([44a4d06](https://github.com/rotorsoft/act-root/commit/44a4d0694a14914b04591002351661c3a2df82d0))
* **act:** improve batch projection benchmark — drain-phase only measurement ([cb1fa2b](https://github.com/rotorsoft/act-root/commit/cb1fa2bffcce96c83bc926327f03157666e13c69))
* **act:** pg batch benchmark at 1K/5K/10K — consistent ~19x speedup ([4b25585](https://github.com/rotorsoft/act-root/commit/4b25585b63c472b5fd43882c4cf5d3a63fe16daf))

# [@rotorsoft/act-v0.25.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.25.1...@rotorsoft/act-v0.25.2) (2026-03-29)


### Bug Fixes

* **security:** sanitize SQL identifiers, escape RegExp, fix code injection vectors ([afbe25e](https://github.com/rotorsoft/act-root/commit/afbe25e5e61c75d0d245070bb6c9b79affb9fe74))

# [@rotorsoft/act-v0.25.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.25.0...@rotorsoft/act-v0.25.1) (2026-03-27)


### Bug Fixes

* **act, act-pg:** add stream_exact query option for exact stream matching ([1ed4e5b](https://github.com/rotorsoft/act-root/commit/1ed4e5bf98ac454d60ea5aa9563e5338c75e2b2d))

# [@rotorsoft/act-v0.25.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.24.1...@rotorsoft/act-v0.25.0) (2026-03-25)


### Features

* **act:** add Logger interface JSDoc cross-references ([e9772d5](https://github.com/rotorsoft/act-root/commit/e9772d54fc5e70eed9b010d97efdfe96a68d1bfb))

# [@rotorsoft/act-v0.24.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.24.0...@rotorsoft/act-v0.24.1) (2026-03-24)


### Bug Fixes

* **act:** patch merge priority for partial states and diagram projection layout ([36bb9a2](https://github.com/rotorsoft/act-root/commit/36bb9a2614d7786164b034db60d73109d98de287))

# [@rotorsoft/act-v0.24.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.23.2...@rotorsoft/act-v0.24.0) (2026-03-24)


### Features

* **act, act-diagram:** replace Dispatcher with IAct interface and fix multi-reaction layout ([806e886](https://github.com/rotorsoft/act-root/commit/806e886868c16dabf2b71662479b68ecb0ebfe11))

# [@rotorsoft/act-v0.23.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.23.1...@rotorsoft/act-v0.23.2) (2026-03-16)


### Bug Fixes

* clear _needs_drain on empty claim, 100% line/function coverage, realistic PG bench ([08e350a](https://github.com/rotorsoft/act-root/commit/08e350a932d7a7deb7fe5101c346831c0386858a))
* import Patch directly from act-patch instead of re-exporting ([8d2f6a5](https://github.com/rotorsoft/act-root/commit/8d2f6a5df5a040ce682635521b932a1af7ea86c1))
* remove v8 ignore comments, clean up tests for act.ts 100% line/function coverage ([54a7ba9](https://github.com/rotorsoft/act-root/commit/54a7ba98f4d8fde040e49587d096556787e83f72))
* resolve pre-existing type errors caught by CI typecheck ([5222bdd](https://github.com/rotorsoft/act-root/commit/5222bdd9a3f67712345caad6fa35bef424e03728))
* restore millis guard in lease() as input validation, add test ([7c1831e](https://github.com/rotorsoft/act-root/commit/7c1831e4418035fdd904a5b37ff79b8a8129c7b8))


### Performance Improvements

* add drain-skip benchmark (2.58x faster for non-reactive events) ([c22cb68](https://github.com/rotorsoft/act-root/commit/c22cb689a0dffcd7d6d1cd8f948c2eb0f53b838a))
* skip drain when no committed events have reactions ([765e4ea](https://github.com/rotorsoft/act-root/commit/765e4ea89226545c3c40354c4d09d98a9fdbddfa)), closes [#482](https://github.com/rotorsoft/act-root/issues/482)

# [@rotorsoft/act-v0.23.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.23.0...@rotorsoft/act-v0.23.1) (2026-03-15)


### Bug Fixes

* **act:** advance correlation checkpoint after subscribe succeeds ([ea55030](https://github.com/rotorsoft/act-root/commit/ea55030cbf4ae14da10783c26bf8aebd6e7f6908))

# [@rotorsoft/act-v0.23.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.22.0...@rotorsoft/act-v0.23.0) (2026-03-15)


### Features

* **act:** watermark-aware claim filtering ([23fcb78](https://github.com/rotorsoft/act-root/commit/23fcb7838dfd9c115d35faeb59cbf5989200028e))

# [@rotorsoft/act-v0.22.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.21.0...@rotorsoft/act-v0.22.0) (2026-03-15)


### Features

* **act:** correlation checkpoint with static resolver optimization ([2291906](https://github.com/rotorsoft/act-root/commit/2291906202aa5fdc332b7e9c96fc63fea85c8b8e))

# [@rotorsoft/act-v0.21.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.20.0...@rotorsoft/act-v0.21.0) (2026-03-15)


### Features

* **act:** replace poll/lease with claim/subscribe ([18a1444](https://github.com/rotorsoft/act-root/commit/18a1444f287046d1b1612e7f35f02f11e0a4e729))


### Performance Improvements

* **act:** add multi-worker contention benchmark ([9787cb6](https://github.com/rotorsoft/act-root/commit/9787cb6caec65787fd80f8f4aa31674ddd121a1f))

# [@rotorsoft/act-v0.20.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.19.1...@rotorsoft/act-v0.20.0) (2026-03-14)


### Features

* **act:** add Cache port with InMemoryCache LRU adapter ([561f183](https://github.com/rotorsoft/act-root/commit/561f183345c9fa36daafea98ff0601759515d67d)), closes [#453](https://github.com/rotorsoft/act-root/issues/453)
* **act:** add PostgresStore cache benchmark and fix coverage ([8f8a901](https://github.com/rotorsoft/act-root/commit/8f8a901f326b637d94de075c129dbb3bc6e0d04d))
* **act:** add snap variants to cache benchmarks ([83ae55b](https://github.com/rotorsoft/act-root/commit/83ae55ba421669453280764729c1fae87372e81b))
* **act:** always-on cache with snap timing fix ([f797233](https://github.com/rotorsoft/act-root/commit/f7972335ee507bffe75b184e599b5b6298aaeee4))

# [@rotorsoft/act-v0.19.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.19.0...@rotorsoft/act-v0.19.1) (2026-03-14)


### Bug Fixes

* **act:** use workspace:^ and order CD matrix by dependency chain ([4a5287e](https://github.com/rotorsoft/act-root/commit/4a5287eb53a038cf8e81fcc8493427f7125fd94e))

# [@rotorsoft/act-v0.19.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.18.0...@rotorsoft/act-v0.19.0) (2026-03-14)


### Features

* **act-patch:** extract shared patch utility into @rotorsoft/act-patch ([7831b4c](https://github.com/rotorsoft/act-root/commit/7831b4cc87b6fcdca4f7ac36529784e01e3fa506)), closes [#452](https://github.com/rotorsoft/act-root/issues/452)

# [@rotorsoft/act-v0.18.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.17.1...@rotorsoft/act-v0.18.0) (2026-03-13)


### Features

* replace RFC 6902 JSON Patch with domain patches ([e6b96bd](https://github.com/rotorsoft/act-root/commit/e6b96bd3d624f064d956779760f64fdd0fc3e362))

# [@rotorsoft/act-v0.17.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.17.0...@rotorsoft/act-v0.17.1) (2026-03-12)


### Bug Fixes

* **act-sse:** inline fast-json-patch to avoid CJS/ESM interop issues ([85fec69](https://github.com/rotorsoft/act-root/commit/85fec694a0d73b7bc757bb73a0737f4c440ed712))

# [@rotorsoft/act-v0.17.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.16.0...@rotorsoft/act-v0.17.0) (2026-03-02)


### Features

* **act:** add InferEvents utility type ([6d740ae](https://github.com/rotorsoft/act-root/commit/6d740ae8cea53f92ea1b4123dd0b83581ea92740))

# [@rotorsoft/act-v0.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.15.0...@rotorsoft/act-v0.16.0) (2026-02-22)


### Features

* **act:** add settle() for debounced correlate→drain with "settled" lifecycle event ([303cc4b](https://github.com/rotorsoft/act-root/commit/303cc4b4dc4ac7d65cf8b05077e780fac393404f))

# [@rotorsoft/act-v0.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.14.0...@rotorsoft/act-v0.15.0) (2026-02-21)


### Features

* **act:** add generic actor type and rename generics to TPrefix convention ([79a8ca7](https://github.com/rotorsoft/act-root/commit/79a8ca7682eec69ca33591ddecfd2a1b49fd124e))

# [@rotorsoft/act-v0.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.13.0...@rotorsoft/act-v0.14.0) (2026-02-20)


### Features

* **act:** streamline state builder with passthrough defaults ([fe1362f](https://github.com/rotorsoft/act-root/commit/fe1362fd912c14257fb4cfa1e765d0c85c5eb410))

# [@rotorsoft/act-v0.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.12.2...@rotorsoft/act-v0.13.0) (2026-02-18)


### Features

* rename builder methods to improve typings ([a22dd89](https://github.com/rotorsoft/act-root/commit/a22dd8969b52525fa340a9d4d35b4a679fdb2242))

# [@rotorsoft/act-v0.12.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.12.1...@rotorsoft/act-v0.12.2) (2026-02-18)


### Bug Fixes

* **act:** fix strict type accumulation in all builders ([a2f2bed](https://github.com/rotorsoft/act-root/commit/a2f2bed9cc2770db8905214b32edd6e5ac112c8e)), closes [#413](https://github.com/rotorsoft/act-root/issues/413)

# [@rotorsoft/act-v0.12.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.12.0...@rotorsoft/act-v0.12.1) (2026-02-18)


### Bug Fixes

* **act:** fix strict typings in builders — slice with projections type constraints ([06ee460](https://github.com/rotorsoft/act-root/commit/06ee460be8d508d3875ac4951a5277771cee1a40)), closes [#411](https://github.com/rotorsoft/act-root/issues/411)

# [@rotorsoft/act-v0.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.11.1...@rotorsoft/act-v0.12.0) (2026-02-18)


### Features

* **act:** support adding projections to slices for encapsulated feature composition ([5ed605f](https://github.com/rotorsoft/act-root/commit/5ed605f8a085f7374a0b47e6c3b69ba9956bb0e8)), closes [#409](https://github.com/rotorsoft/act-root/issues/409)

# [@rotorsoft/act-v0.11.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.11.0...@rotorsoft/act-v0.11.1) (2026-02-14)


### Bug Fixes

* **deps:** update dependency pino to ^10.3.1 ([dd58715](https://github.com/rotorsoft/act-root/commit/dd58715487e1b59ac27edcb515d60c418d338469))

# [@rotorsoft/act-v0.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.10.0...@rotorsoft/act-v0.11.0) (2026-02-13)


### Features

* **act:** replace state("Name", schema) with state({ Name: schema }) record shorthand ([db9a3f2](https://github.com/rotorsoft/act-root/commit/db9a3f24b661c784496d8a51c0e5176b453a6423)), closes [#390](https://github.com/rotorsoft/act-root/issues/390)

# [@rotorsoft/act-v0.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.9.0...@rotorsoft/act-v0.10.0) (2026-02-13)


### Features

* **act:** add projection builder and extract shared wolfdesk schemas ([a0a2712](https://github.com/rotorsoft/act-root/commit/a0a2712293e76a23641b1c688662d98762bbf9cb)), closes [#386](https://github.com/rotorsoft/act-root/issues/386)

# [@rotorsoft/act-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.8.0...@rotorsoft/act-v0.9.0) (2026-02-13)


### Bug Fixes

* **act:** remove any casts that break type safety in builders ([6ececee](https://github.com/rotorsoft/act-root/commit/6ececeeb479b595bd1f66d2bf99f40254e0aa187))


### Features

* **act:** add slice builder to compose partial states with reactions ([f99d8ab](https://github.com/rotorsoft/act-root/commit/f99d8abc2d6b6b4b567c694d1549782bf782f43d)), closes [#382](https://github.com/rotorsoft/act-root/issues/382)
* **act:** self-contained slices with end-to-end typed dispatch ([8f399a2](https://github.com/rotorsoft/act-root/commit/8f399a2378d10328b26444251ea0b8e4b33ac137))

# [@rotorsoft/act-v0.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.7.0...@rotorsoft/act-v0.8.0) (2026-02-11)


### Bug Fixes

* partial state schemas ([f13cb53](https://github.com/rotorsoft/act-root/commit/f13cb53db258de6a92c3c891901f58bef76df483))
* test coverage and autocompletion issues ([c3cceee](https://github.com/rotorsoft/act-root/commit/c3cceee18fd18d841c256d878a87788945867fe0))


### Features

* **act:** support loading merged state by name ([ec29a46](https://github.com/rotorsoft/act-root/commit/ec29a460b6ca6adb355b51efa94a89ade5595876)), closes [#378](https://github.com/rotorsoft/act-root/issues/378)

# [@rotorsoft/act-v0.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-v0.6.33...@rotorsoft/act-v0.7.0) (2026-02-11)


### Features

* support vertical slices by allowing partial states and builders ([458107a](https://github.com/rotorsoft/act-root/commit/458107aceb0e8a942c8ffb62d157a198507b2b6e))
