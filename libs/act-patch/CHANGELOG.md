# [@rotorsoft/act-patch-v1.2.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.2.2...@rotorsoft/act-patch-v1.2.3) (2026-05-31)


### Bug Fixes

* **act-patch:** delta returns DeepPartial, not Patch — no null in event payloads ([eb101b4](https://github.com/rotorsoft/act-root/commit/eb101b47a552036f3e075f0f5979e457dc6777a0))

# [@rotorsoft/act-patch-v1.2.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.2.1...@rotorsoft/act-patch-v1.2.2) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-patch-v1.2.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.2.0...@rotorsoft/act-patch-v1.2.1) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))

# [@rotorsoft/act-patch-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.1.0...@rotorsoft/act-patch-v1.2.0) (2026-05-10)


### Features

* **act:** reaction latency bench + workspace bench unification (ACT-103) ([79d419d](https://github.com/rotorsoft/act-root/commit/79d419dbee73dc0fbda65599e4f687362471aecd))

# [@rotorsoft/act-patch-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.0.2...@rotorsoft/act-patch-v1.1.0) (2026-04-30)


### Bug Fixes

* **act-patch:** type delta's working object as Record<string, unknown> ([39d8980](https://github.com/rotorsoft/act-root/commit/39d898078544d9975735a9381d7a91587f8a0ee4))


### Features

* **act-patch:** add delta(before, after) — inverse of patch ([c324082](https://github.com/rotorsoft/act-root/commit/c324082d391928c0600bfecda55e4d68396d8b7a))

# [@rotorsoft/act-patch-v1.0.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.0.1...@rotorsoft/act-patch-v1.0.2) (2026-03-14)


### Performance Improvements

* **act-patch:** hybrid copy strategy and O(1) mergeability check ([2d479cb](https://github.com/rotorsoft/act-root/commit/2d479cbb263adb7b8c2ecae68107e0f107ace00e))

# [@rotorsoft/act-patch-v1.0.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-patch-v1.0.0...@rotorsoft/act-patch-v1.0.1) (2026-03-14)


### Bug Fixes

* **docs:** escape curly braces in patch docstring for MDX compatibility ([64c2b45](https://github.com/rotorsoft/act-root/commit/64c2b45bd7d74d926a8a4345c80766f4bd6943c4))

# @rotorsoft/act-patch-v1.0.0 (2026-03-14)


### Bug Fixes

* **ci:** add build step before test and include act-patch in CD matrix ([48c58f2](https://github.com/rotorsoft/act-root/commit/48c58f2b68160928c3e41759503ffa423af1d0f6))


### Features

* **act-patch:** extract shared patch utility into @rotorsoft/act-patch ([7831b4c](https://github.com/rotorsoft/act-root/commit/7831b4cc87b6fcdca4f7ac36529784e01e3fa506)), closes [#452](https://github.com/rotorsoft/act-root/issues/452)
