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
