# [@rotorsoft/act-diagram-v1.0.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v1.0.3...@rotorsoft/act-diagram-v1.0.4) (2026-06-16)


### Bug Fixes

* **deps:** update lucide monorepo to ^1.18.0 ([c5e6c86](https://github.com/rotorsoft/act-root/commit/c5e6c867cfdade3b44b24aa36a3dc960ae310fa8))

# [@rotorsoft/act-diagram-v1.0.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v1.0.2...@rotorsoft/act-diagram-v1.0.3) (2026-06-09)

# [@rotorsoft/act-diagram-v1.0.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v1.0.1...@rotorsoft/act-diagram-v1.0.2) (2026-06-07)


### Bug Fixes

* **deps:** update lucide monorepo to v1 ([c2bc752](https://github.com/rotorsoft/act-root/commit/c2bc75282f4e9be3a2b528332630683079766e3c))

# [@rotorsoft/act-diagram-v1.0.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v1.0.0...@rotorsoft/act-diagram-v1.0.1) (2026-06-07)

# [@rotorsoft/act-diagram-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.4.0...@rotorsoft/act-diagram-v1.0.0) (2026-05-21)


* chore(act-diagram)!: enter 1.0 stability commitment ([3253475](https://github.com/rotorsoft/act-root/commit/3253475f6607fe55e68427b03b326017b4731458)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-diagram.
The package's public exports — the React component, the parsed-model
types, and the `act` CLI's command surface — are now covered by SemVer
per STABILITY.md. The diagram's output shape (SVG structure, click-
through anchors) is explicitly NOT part of the stability surface and
may evolve.

# [@rotorsoft/act-diagram-v0.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.10...@rotorsoft/act-diagram-v0.4.0) (2026-05-15)


### Bug Fixes

* **act-diagram:** cap type-annotation regex repetitions to kill ReDoS ([f086bd2](https://github.com/rotorsoft/act-root/commit/f086bd275c82e9bed431c29ecb12f63bb60e2073)), closes [#29](https://github.com/rotorsoft/act-root/issues/29) [#let](https://github.com/rotorsoft/act-root/issues/let) [#let](https://github.com/rotorsoft/act-root/issues/let) [#let](https://github.com/rotorsoft/act-root/issues/let)
* **act-diagram:** unblock CI by disabling color in tests and de-fanging ReDoS ([931168f](https://github.com/rotorsoft/act-root/commit/931168fd86e9b28cc17bedd0f0377458712118d2)), closes [#let](https://github.com/rotorsoft/act-root/issues/let)
* **act-diagram:** unblock CI smoke by collapsing equivalent -q matches ([ba1921f](https://github.com/rotorsoft/act-root/commit/ba1921f627f3632b8d845fd8b328eb13ee433cfd))


### Features

* **act-diagram:** interactive `act` CLI for contracts exploration (ACT-402) ([b66c4d0](https://github.com/rotorsoft/act-root/commit/b66c4d01f0a2715b5cdd6dbdb88540c9db5827b6))
* **act-diagram:** resolve cross-file Zod identifiers + richer tooltips ([10bdb0d](https://github.com/rotorsoft/act-root/commit/10bdb0d08653259fafcad68a142a4000256c25b2))
* **act-diagram:** stamp package version into toolbar ([e07ea08](https://github.com/rotorsoft/act-root/commit/e07ea08e276b42accf7f25055a1ab7c5924b6b1f))
* **act-diagram:** structured details tooltip with schema code block ([5e3fd27](https://github.com/rotorsoft/act-root/commit/5e3fd27f76c30ca8d4cae6568b3b9fb2608bb6ad))

# [@rotorsoft/act-diagram-v0.3.10](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.9...@rotorsoft/act-diagram-v0.3.10) (2026-05-10)


### Bug Fixes

* **ci:** rebuild dist in CD instead of relying on broken artifact ([992a334](https://github.com/rotorsoft/act-root/commit/992a334fa356b98ec6dbbb34674318f77e067f78))

# [@rotorsoft/act-diagram-v0.3.9](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.8...@rotorsoft/act-diagram-v0.3.9) (2026-05-10)


### Bug Fixes

* unify workspace bench config + repair CI bench summary + npm keywords ([56b192c](https://github.com/rotorsoft/act-root/commit/56b192c1bd6d217a76099c7d185d0620d908edc0))

# [@rotorsoft/act-diagram-v0.3.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.7...@rotorsoft/act-diagram-v0.3.8) (2026-05-09)


### Bug Fixes

* **builders:** split .emit() overloads + zod as peer dep ([b766671](https://github.com/rotorsoft/act-root/commit/b76667124752d9dbc5e34e1508d3628f8eb6112d))

# [@rotorsoft/act-diagram-v0.3.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.6...@rotorsoft/act-diagram-v0.3.7) (2026-05-06)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.3 ([84c5bc7](https://github.com/rotorsoft/act-root/commit/84c5bc77bd55edb427f202ce43acf38878c23003))

# [@rotorsoft/act-diagram-v0.3.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.5...@rotorsoft/act-diagram-v0.3.6) (2026-05-04)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.2 ([abaa2ee](https://github.com/rotorsoft/act-root/commit/abaa2ee59989073b1bdb67fa1f989e2572fddb04))

# [@rotorsoft/act-diagram-v0.3.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.4...@rotorsoft/act-diagram-v0.3.5) (2026-05-03)

# [@rotorsoft/act-diagram-v0.3.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.3...@rotorsoft/act-diagram-v0.3.4) (2026-05-01)


### Bug Fixes

* **deps:** update dependency zod to ^4.4.1 ([de538f5](https://github.com/rotorsoft/act-root/commit/de538f5e61a43cbdcb25d07049579d4a0eab0e8a))

# [@rotorsoft/act-diagram-v0.3.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.2...@rotorsoft/act-diagram-v0.3.3) (2026-04-15)

# [@rotorsoft/act-diagram-v0.3.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.1...@rotorsoft/act-diagram-v0.3.2) (2026-03-29)


### Bug Fixes

* **security:** sanitize SQL identifiers, escape RegExp, fix code injection vectors ([afbe25e](https://github.com/rotorsoft/act-root/commit/afbe25e5e61c75d0d245070bb6c9b79affb9fe74))

# [@rotorsoft/act-diagram-v0.3.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.3.0...@rotorsoft/act-diagram-v0.3.1) (2026-03-26)


### Bug Fixes

* **security:** resolve ReDoS and dependency vulnerabilities ([e0a7945](https://github.com/rotorsoft/act-root/commit/e0a7945659b7354aa95ff2109444b00c3b6b39be))

# [@rotorsoft/act-diagram-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.2.2...@rotorsoft/act-diagram-v0.3.0) (2026-03-25)


### Features

* **act-diagram:** export pre-built Tailwind CSS for consumers ([3ef29a2](https://github.com/rotorsoft/act-root/commit/3ef29a21667d7d935f19ed82ebfed2338cebbfa1))

# [@rotorsoft/act-diagram-v0.2.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.2.1...@rotorsoft/act-diagram-v0.2.2) (2026-03-24)


### Bug Fixes

* **act:** patch merge priority for partial states and diagram projection layout ([36bb9a2](https://github.com/rotorsoft/act-root/commit/36bb9a2614d7786164b034db60d73109d98de287))

# [@rotorsoft/act-diagram-v0.2.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.2.0...@rotorsoft/act-diagram-v0.2.1) (2026-03-24)


### Bug Fixes

* **act-diagram:** debounce extraction and keep last good model during file changes ([dd3becf](https://github.com/rotorsoft/act-root/commit/dd3becf295d064ee738f6753a584663ab5b11f4a))

# [@rotorsoft/act-diagram-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.3...@rotorsoft/act-diagram-v0.2.0) (2026-03-24)


### Features

* **act, act-diagram:** replace Dispatcher with IAct interface and fix multi-reaction layout ([806e886](https://github.com/rotorsoft/act-root/commit/806e886868c16dabf2b71662479b68ecb0ebfe11))

# [@rotorsoft/act-diagram-v0.1.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.2...@rotorsoft/act-diagram-v0.1.3) (2026-03-23)


### Bug Fixes

* **act-diagram:** strip non-code from source scanning and navigation ([61167e8](https://github.com/rotorsoft/act-root/commit/61167e8ea2c203fe5c803d0d3b668d690cc0ad5e))

# [@rotorsoft/act-diagram-v0.1.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.1...@rotorsoft/act-diagram-v0.1.2) (2026-03-23)


### Bug Fixes

* **act-diagram:** filter entries to only show their own slices/states/projections ([bd9145d](https://github.com/rotorsoft/act-root/commit/bd9145d6b538b52f7f26b4b363a765ee90a7c328))

# [@rotorsoft/act-diagram-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.0...@rotorsoft/act-diagram-v0.1.1) (2026-03-23)


### Bug Fixes

* **act-diagram:** export buildModel, computeLayout, ExecuteResult from public API ([c21b096](https://github.com/rotorsoft/act-root/commit/c21b096abed3c16126548e50ac6ceb87ad9b9e67))
* **act-diagram:** re-trigger CI publish ([67273b6](https://github.com/rotorsoft/act-root/commit/67273b60e151276833ab27d7973394329f7cf06f))
* **act-diagram:** trigger npm publish ([ed817e2](https://github.com/rotorsoft/act-root/commit/ed817e2401ae08a8efd79b89470fc39a3f48570b))

# [@rotorsoft/act-diagram-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.0...@rotorsoft/act-diagram-v0.1.1) (2026-03-23)


### Bug Fixes

* **act-diagram:** export buildModel, computeLayout, ExecuteResult from public API ([c21b096](https://github.com/rotorsoft/act-root/commit/c21b096abed3c16126548e50ac6ceb87ad9b9e67))
* **act-diagram:** re-trigger CI publish ([67273b6](https://github.com/rotorsoft/act-root/commit/67273b60e151276833ab27d7973394329f7cf06f))
* **act-diagram:** trigger npm publish ([ed817e2](https://github.com/rotorsoft/act-root/commit/ed817e2401ae08a8efd79b89470fc39a3f48570b))

# [@rotorsoft/act-diagram-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.0...@rotorsoft/act-diagram-v0.1.1) (2026-03-23)


### Bug Fixes

* **act-diagram:** export buildModel, computeLayout, ExecuteResult from public API ([c21b096](https://github.com/rotorsoft/act-root/commit/c21b096abed3c16126548e50ac6ceb87ad9b9e67))
* **act-diagram:** re-trigger CI publish ([67273b6](https://github.com/rotorsoft/act-root/commit/67273b60e151276833ab27d7973394329f7cf06f))
* **act-diagram:** trigger npm publish ([ed817e2](https://github.com/rotorsoft/act-root/commit/ed817e2401ae08a8efd79b89470fc39a3f48570b))

# [@rotorsoft/act-diagram-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.0...@rotorsoft/act-diagram-v0.1.1) (2026-03-23)


### Bug Fixes

* **act-diagram:** export buildModel, computeLayout, ExecuteResult from public API ([c21b096](https://github.com/rotorsoft/act-root/commit/c21b096abed3c16126548e50ac6ceb87ad9b9e67))
* **act-diagram:** re-trigger CI publish ([67273b6](https://github.com/rotorsoft/act-root/commit/67273b60e151276833ab27d7973394329f7cf06f))
* **act-diagram:** trigger npm publish ([ed817e2](https://github.com/rotorsoft/act-root/commit/ed817e2401ae08a8efd79b89470fc39a3f48570b))

# [@rotorsoft/act-diagram-v0.1.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.1...@rotorsoft/act-diagram-v0.1.2) (2026-03-23)


### Bug Fixes

* **act-diagram:** export buildModel, computeLayout, ExecuteResult from public API ([c21b096](https://github.com/rotorsoft/act-root/commit/c21b096abed3c16126548e50ac6ceb87ad9b9e67))

# [@rotorsoft/act-diagram-v0.1.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-diagram-v0.1.0...@rotorsoft/act-diagram-v0.1.1) (2026-03-23)


### Bug Fixes

* **act-diagram:** trigger npm publish ([ed817e2](https://github.com/rotorsoft/act-root/commit/ed817e2401ae08a8efd79b89470fc39a3f48570b))

# @rotorsoft/act-diagram-v1.0.0 (2026-03-23)


### Bug Fixes

* **act-diagram:** bottom-up extraction with per-slice error handling ([148fe63](https://github.com/rotorsoft/act-root/commit/148fe63f5d6be445d4378fc404622734f9116f4f))
* **act-diagram:** coverage threshold, test coverage, extraction resilience ([ba3276b](https://github.com/rotorsoft/act-root/commit/ba3276bfcbec5d383a22cdf014864811cbd1a701))
* **act-diagram:** isolate per-slice compilation in extractModel ([80eaf6a](https://github.com/rotorsoft/act-root/commit/80eaf6a1ad68f045f9455649e0f652de306d5275))
* **act-diagram:** per-slice error handling, layout improvements, relay resilience ([13cf4af](https://github.com/rotorsoft/act-root/commit/13cf4afa98209f79a592f485bcf354fc05b14e02))
* **act-diagram:** preserve slice position alignment in act builder ([b8ad065](https://github.com/rotorsoft/act-root/commit/b8ad0652e0174aabe109e6824a2d02a776ee840c))
* **act-diagram:** remove regex fallback, use error placeholder slices ([88ce968](https://github.com/rotorsoft/act-root/commit/88ce968ede98ecd7d9addf73d4faa04f9bcd0f6a))
* **act-diagram:** strip seed() calls, silence eval console, document security ([b54d42b](https://github.com/rotorsoft/act-root/commit/b54d42b3b8f90febde2909048b07ff1d7258c4c7))
* **act-nvim:** address CodeQL security alerts ([6beb7a9](https://github.com/rotorsoft/act-root/commit/6beb7a9d7d56430c2ac165b9a422cf5b9d1b3cd0))
* **act-nvim:** kill orphan relays, guard _varName on null slices ([e28d0ea](https://github.com/rotorsoft/act-root/commit/e28d0eaf80b11acdea04def218dba2dc32f7308a))


### Features

* **act-diagram:** add AI controls, fix-with-AI warnings, event navigation ([b6605e4](https://github.com/rotorsoft/act-root/commit/b6605e4a2acdb41ac812ab4fd39bc8f2ef90bf1e))
* **act-diagram:** add fileAdded to protocol, diff-based poll ([36b5cda](https://github.com/rotorsoft/act-root/commit/36b5cda9d302f25d070ba0b970dc385e64690197))
* **act-diagram:** dev app with code preview, AI integration, navigation fixes ([92f1ccf](https://github.com/rotorsoft/act-root/commit/92f1ccf8ee0d424b3112a85c6e49cb1253e6477d))
* **act-diagram:** folder picker in dev mode ([6dcbf67](https://github.com/rotorsoft/act-root/commit/6dcbf67a84c9cf4642d1195b8518a26fe3e81de7))
* **act-nvim:** add Neovim plugin for interactive Act diagrams in browser ([8268e48](https://github.com/rotorsoft/act-root/commit/8268e483af56ad865a7b36665972d2a20de69ed0))
* **act-nvim:** forward LSP diagnostics to diagram for per-slice errors ([98d363c](https://github.com/rotorsoft/act-root/commit/98d363cfdd069ebd8bdd7138266a9c0fdf336421))
