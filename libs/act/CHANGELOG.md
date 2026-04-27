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
