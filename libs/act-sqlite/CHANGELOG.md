# [@rotorsoft/act-sqlite-v1.19.3](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.19.2...@rotorsoft/act-sqlite-v1.19.3) (2026-09-05)


### Bug Fixes

* **act:** keep a stream's lane when the subscriber has forgotten it ([#1612](https://github.com/Rotorsoft/act-root/issues/1612)) ([2978061](https://github.com/Rotorsoft/act-root/commit/29780612c93d1fce4474baeae3dccfdf5428e386)), closes [#1598](https://github.com/Rotorsoft/act-root/issues/1598) [#1599](https://github.com/Rotorsoft/act-root/issues/1599)
* **act:** revive dates on read instead of re-validating the payload ([#1601](https://github.com/Rotorsoft/act-root/issues/1601)) ([97ed5b9](https://github.com/Rotorsoft/act-root/commit/97ed5b9190601127e48d0b102c998eec95c38c78)), closes [#1594](https://github.com/Rotorsoft/act-root/issues/1594)

# [@rotorsoft/act-sqlite-v1.19.2](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.19.1...@rotorsoft/act-sqlite-v1.19.2) (2026-08-27)


### Bug Fixes

* **act:** explain a failed correlation-lease handback instead of logging it raw ([#1578](https://github.com/Rotorsoft/act-root/issues/1578)) ([7a64bd9](https://github.com/Rotorsoft/act-root/commit/7a64bd987a7161e02caac4e5842435b0290fd9bb)), closes [#1577](https://github.com/Rotorsoft/act-root/issues/1577) [#1577](https://github.com/Rotorsoft/act-root/issues/1577)

# [@rotorsoft/act-sqlite-v1.19.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.19.0...@rotorsoft/act-sqlite-v1.19.1) (2026-08-25)


### Bug Fixes

* **act:** let the schema decide which fields are dates ([#1570](https://github.com/Rotorsoft/act-root/issues/1570)) ([dca2166](https://github.com/Rotorsoft/act-root/commit/dca2166ad756b39dbb5b6287057fc67c5222a5e6)), closes [#1556](https://github.com/Rotorsoft/act-root/issues/1556)

# [@rotorsoft/act-sqlite-v1.19.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.18.0...@rotorsoft/act-sqlite-v1.19.0) (2026-08-22)


### Features

* **act:** one worker reads the event log for all of them ([#1537](https://github.com/Rotorsoft/act-root/issues/1537)) ([6cb58f3](https://github.com/Rotorsoft/act-root/commit/6cb58f35dcee98ce1c96053bc73fcb54e111d986))

# [@rotorsoft/act-sqlite-v1.18.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.17.0...@rotorsoft/act-sqlite-v1.18.0) (2026-08-21)


### Features

* **act:** truncate no longer removes subscriptions ([463cab3](https://github.com/Rotorsoft/act-root/commit/463cab3ed1d60ec932fb5945856121385998cb67))

# [@rotorsoft/act-sqlite-v1.17.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.16.1...@rotorsoft/act-sqlite-v1.17.0) (2026-08-18)


### Features

* **act:** claim reads the work mark and nothing else ([#1511](https://github.com/Rotorsoft/act-root/issues/1511)) ([579c775](https://github.com/Rotorsoft/act-root/commit/579c7751f66a51eacb374bb6350d51c869af093c)), closes [#1446](https://github.com/Rotorsoft/act-root/issues/1446) [#1510](https://github.com/Rotorsoft/act-root/issues/1510)

# [@rotorsoft/act-sqlite-v1.16.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.16.0...@rotorsoft/act-sqlite-v1.16.1) (2026-08-18)


### Bug Fixes

* **act:** match GitHub's owner casing in repository.url ([a719f54](https://github.com/Rotorsoft/act-root/commit/a719f548acb22cd303a229a4c4dafbf8f8e4f5b7))

# [@rotorsoft/act-sqlite-v1.16.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.15.0...@rotorsoft/act-sqlite-v1.16.0) (2026-08-18)


### Features

* **act:** correlate becomes the universal producer of the work mark ([#1497](https://github.com/rotorsoft/act-root/issues/1497)) ([0fe7380](https://github.com/rotorsoft/act-root/commit/0fe7380f2d5dc94080b24776f3bd6ca46a55d603)), closes [#1496](https://github.com/rotorsoft/act-root/issues/1496) [#1487](https://github.com/rotorsoft/act-root/issues/1487)

# [@rotorsoft/act-sqlite-v1.15.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.14.0...@rotorsoft/act-sqlite-v1.15.0) (2026-08-16)


### Features

* **act:** subscription work set — claim reads eligibility off the subscription row ([#1496](https://github.com/rotorsoft/act-root/issues/1496)) ([d31452c](https://github.com/rotorsoft/act-root/commit/d31452c823cda9ed90d9e50f23cee0443978dead)), closes [#1484](https://github.com/rotorsoft/act-root/issues/1484)

# [@rotorsoft/act-sqlite-v1.14.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.13.1...@rotorsoft/act-sqlite-v1.14.0) (2026-08-16)


### Features

* **act:** make the correlate checkpoint durable ([#1493](https://github.com/rotorsoft/act-root/issues/1493)) ([bea07fb](https://github.com/rotorsoft/act-root/commit/bea07fba0822371cd730108bd917c9e289001321)), closes [#1484](https://github.com/rotorsoft/act-root/issues/1484) [#1484](https://github.com/rotorsoft/act-root/issues/1484)

# [@rotorsoft/act-sqlite-v1.13.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.13.0...@rotorsoft/act-sqlite-v1.13.1) (2026-08-13)


### Bug Fixes

* **act-sqlite:** apply the priority max-merge to non-positive values ([a272abb](https://github.com/rotorsoft/act-root/commit/a272abbfd3838184d1ece44a201f509ca81b4c2e)), closes [#1445](https://github.com/rotorsoft/act-root/issues/1445)

# [@rotorsoft/act-sqlite-v1.13.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.16...@rotorsoft/act-sqlite-v1.13.0) (2026-08-11)


### Bug Fixes

* **act-sqlite:** require an explicit url and repair in-memory ([5d1383b](https://github.com/rotorsoft/act-root/commit/5d1383b6c5235581be07891b6637016fe8ecce7d)), closes [#1443](https://github.com/rotorsoft/act-root/issues/1443)


### Features

* **act-tck:** cover an adapter's own default config ([b622a96](https://github.com/rotorsoft/act-root/commit/b622a960a354b7b4618452b828cbb12a67f8a8a9)), closes [#1443](https://github.com/rotorsoft/act-root/issues/1443)

# [@rotorsoft/act-sqlite-v1.12.16](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.15...@rotorsoft/act-sqlite-v1.12.16) (2026-08-09)


### Performance Improvements

* **act-pg:** make claim's has-work probe sargable and index it ([2276fc1](https://github.com/rotorsoft/act-root/commit/2276fc109246bd51deb56d5825a332ee697b24df))

# [@rotorsoft/act-sqlite-v1.12.15](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.14...@rotorsoft/act-sqlite-v1.12.15) (2026-08-08)


### Bug Fixes

* **act:** keep a restarted stream's subscription and forget a retired one ([5b57672](https://github.com/rotorsoft/act-root/commit/5b57672dbe44d78e3deac16be8fcc9fb90118b19)), closes [#1363](https://github.com/rotorsoft/act-root/issues/1363) [#1398](https://github.com/rotorsoft/act-root/issues/1398)

# [@rotorsoft/act-sqlite-v1.12.14](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.13...@rotorsoft/act-sqlite-v1.12.14) (2026-08-06)


### Bug Fixes

* **act-sqlite:** return the post-block row from block(), not the caller's lease ([0555d07](https://github.com/rotorsoft/act-root/commit/0555d07329e4f192161bf4bd36d379e2d6607716)), closes [#1347](https://github.com/rotorsoft/act-root/issues/1347) [#1382](https://github.com/rotorsoft/act-root/issues/1382)

# [@rotorsoft/act-sqlite-v1.12.13](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.12...@rotorsoft/act-sqlite-v1.12.13) (2026-08-06)


### Bug Fixes

* **act-crypto:** revive dates when decrypting pii payloads ([1a79178](https://github.com/rotorsoft/act-root/commit/1a7917883db522b5fba9935ceef99f15fe8de6ec)), closes [#1365](https://github.com/rotorsoft/act-root/issues/1365) [#1370](https://github.com/rotorsoft/act-root/issues/1370) [#1365](https://github.com/rotorsoft/act-root/issues/1365)

# [@rotorsoft/act-sqlite-v1.12.12](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.11...@rotorsoft/act-sqlite-v1.12.12) (2026-08-05)


### Bug Fixes

* **act-sqlite:** revive a Date in a pii field on read, matching data/meta ([fca5ed8](https://github.com/rotorsoft/act-root/commit/fca5ed86268a4dd0015549f9f9abf1b42026726e)), closes [#1198](https://github.com/rotorsoft/act-root/issues/1198) [#1198](https://github.com/rotorsoft/act-root/issues/1198) [#1365](https://github.com/rotorsoft/act-root/issues/1365)

# [@rotorsoft/act-sqlite-v1.12.11](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.10...@rotorsoft/act-sqlite-v1.12.11) (2026-08-04)


### Bug Fixes

* **act:** reset/defer array form counts distinct streams, matching PG ([bcb911a](https://github.com/rotorsoft/act-root/commit/bcb911a3132777b16e0ec06c75b009baf1db9f47)), closes [#1360](https://github.com/rotorsoft/act-root/issues/1360)

# [@rotorsoft/act-sqlite-v1.12.10](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.9...@rotorsoft/act-sqlite-v1.12.10) (2026-08-03)


### Bug Fixes

* **deps:** update non-major dependencies ([f3b63d9](https://github.com/rotorsoft/act-root/commit/f3b63d98d9b9e262765700c503d55eec28c290cd))

# [@rotorsoft/act-sqlite-v1.12.9](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.8...@rotorsoft/act-sqlite-v1.12.9) (2026-08-02)


### Bug Fixes

* **act-sqlite:** ack returns authoritative retry -1, not the stale input echo ([a9014e7](https://github.com/rotorsoft/act-root/commit/a9014e71dbf6a8c64fc8c64d150f8798f65a913b)), closes [#1347](https://github.com/rotorsoft/act-root/issues/1347)

# [@rotorsoft/act-sqlite-v1.12.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.7...@rotorsoft/act-sqlite-v1.12.8) (2026-07-21)


### Bug Fixes

* **act-sqlite:** omit pii from query_stats head/tail ([7a78379](https://github.com/rotorsoft/act-root/commit/7a78379df438cc2da19e11d20183f62e84fe52f1)), closes [#1294](https://github.com/rotorsoft/act-root/issues/1294)
* **act:** advance the watermark past the succeeded prefix on partial-progress defers ([#1278](https://github.com/rotorsoft/act-root/issues/1278)) ([4bfd833](https://github.com/rotorsoft/act-root/commit/4bfd83313f375403031c6781b0f7eb01169f74d7))

# [@rotorsoft/act-sqlite-v1.12.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.6...@rotorsoft/act-sqlite-v1.12.7) (2026-07-17)


### Bug Fixes

* **act:** move snapshot-floor eligibility to the orchestrator; delete per-adapter guards ([69c3f09](https://github.com/rotorsoft/act-root/commit/69c3f09a384054f03c4dc1e77dd83fe831f46eb7)), closes [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1267](https://github.com/rotorsoft/act-root/issues/1267) [#1270](https://github.com/rotorsoft/act-root/issues/1270) [#1274](https://github.com/rotorsoft/act-root/issues/1274) [#1267](https://github.com/rotorsoft/act-root/issues/1267) [#1270](https://github.com/rotorsoft/act-root/issues/1270) [#1274](https://github.com/rotorsoft/act-root/issues/1274)

# [@rotorsoft/act-sqlite-v1.12.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.5...@rotorsoft/act-sqlite-v1.12.6) (2026-07-17)


### Bug Fixes

* **act:** persist backoff windows to deferred_at, ending the phantom-retry bug ([ecca43e](https://github.com/rotorsoft/act-root/commit/ecca43e04a77311ab0f81e03e3b9feba1197bced)), closes [#1262](https://github.com/rotorsoft/act-root/issues/1262)

# [@rotorsoft/act-sqlite-v1.12.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.4...@rotorsoft/act-sqlite-v1.12.5) (2026-07-16)


### Bug Fixes

* **act:** suppress snapshot resume-floor under time bounds; guard InMemory re-block ([b0b3ea0](https://github.com/rotorsoft/act-root/commit/b0b3ea0861ac27a28373dff5b545b9b4bbd7b8f9)), closes [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1263](https://github.com/rotorsoft/act-root/issues/1263) [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1263](https://github.com/rotorsoft/act-root/issues/1263)

# [@rotorsoft/act-sqlite-v1.12.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.3...@rotorsoft/act-sqlite-v1.12.4) (2026-07-15)


### Bug Fixes

* **act:** reserve a fairness slot in the lagging frontier ([ff4b47a](https://github.com/rotorsoft/act-root/commit/ff4b47ade333215d4758ab6dd588d95229868bf1)), closes [hi#priority](https://github.com/hi/issues/priority) [#1223](https://github.com/rotorsoft/act-root/issues/1223)

# [@rotorsoft/act-sqlite-v1.12.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.2...@rotorsoft/act-sqlite-v1.12.3) (2026-07-11)


### Bug Fixes

* **act-sqlite:** case-sensitive filters, date revival, error mapping (ACT-1197/1198/1199/1202) ([a46158e](https://github.com/rotorsoft/act-root/commit/a46158e4ef0316a20cf9127d77a4dc359d2c861b))
* **act:** orphaned-lane advisory, defer durability across restart, audit lane universe ([1dee16d](https://github.com/rotorsoft/act-root/commit/1dee16d09f4aab2efaef5447ca6c7d924419dd8c))

# [@rotorsoft/act-sqlite-v1.12.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.1...@rotorsoft/act-sqlite-v1.12.2) (2026-07-11)


### Bug Fixes

* **act:** restore regex claim sources with a literal fast-path ([3abd00d](https://github.com/rotorsoft/act-root/commit/3abd00d53848948aa0d7a59a4884a47a0e6000eb)), closes [#1215](https://github.com/rotorsoft/act-root/issues/1215) [#1215](https://github.com/rotorsoft/act-root/issues/1215)

# [@rotorsoft/act-sqlite-v1.12.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.12.0...@rotorsoft/act-sqlite-v1.12.1) (2026-07-10)


### Bug Fixes

* **act-sqlite:** treat claim sources as exact stream names ([4eaa407](https://github.com/rotorsoft/act-root/commit/4eaa407b48016ee7d5f42587f077d2b50bd8a132))

# [@rotorsoft/act-sqlite-v1.12.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.11.0...@rotorsoft/act-sqlite-v1.12.0) (2026-07-10)


### Features

* **act-sqlite:** windowed truncate boundary ([b65ca03](https://github.com/rotorsoft/act-root/commit/b65ca0344ca0fba86e90ab26fc4ed3869bf01de9)), closes [#1011](https://github.com/rotorsoft/act-root/issues/1011)

# [@rotorsoft/act-sqlite-v1.11.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.2...@rotorsoft/act-sqlite-v1.11.0) (2026-07-06)


### Features

* **act-pg:** seed-sync is the schema story — pin the contract, harden concurrent boot ([893d620](https://github.com/rotorsoft/act-root/commit/893d620be5ead475f236285a28df17f52e34107c))

# [@rotorsoft/act-sqlite-v1.10.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.1...@rotorsoft/act-sqlite-v1.10.2) (2026-07-05)


### Bug Fixes

* **act:** finalize drain cycles atomically — acks and defer schedules in one store call ([9ab2f26](https://github.com/rotorsoft/act-root/commit/9ab2f26e13999b1f8717984cd5bc088b919969e6))

# [@rotorsoft/act-sqlite-v1.10.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.10.0...@rotorsoft/act-sqlite-v1.10.1) (2026-07-04)


### Bug Fixes

* **act-sqlite:** throw on non-portable stream filter patterns ([#1114](https://github.com/rotorsoft/act-root/issues/1114)) ([14dad8b](https://github.com/rotorsoft/act-root/commit/14dad8be006d25badef426246a6ea1a2126fb5e4))

# [@rotorsoft/act-sqlite-v1.10.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.9.1...@rotorsoft/act-sqlite-v1.10.0) (2026-07-01)


### Bug Fixes

* **act:** run autoclose on a synthetic stream; clamp long defer timers ([#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([d93bfbb](https://github.com/rotorsoft/act-root/commit/d93bfbb67d1ec4ef4245bbc642fdce22c6d0c07e))


### Features

* **act:** add persisted defer outcome + Store.defer (slice 1a-1c, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([c5c46ce](https://github.com/rotorsoft/act-root/commit/c5c46cef7a03c2853434b9e289315d91d2165c59))
* **act:** port autocloses to a synthesized defer/close reaction (slice 1d part 2, [#1090](https://github.com/rotorsoft/act-root/issues/1090)) ([832844a](https://github.com/rotorsoft/act-root/commit/832844a1dffb3ec28fe426de1e1de4c0af8c7267))

# [@rotorsoft/act-sqlite-v1.9.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.9.0...@rotorsoft/act-sqlite-v1.9.1) (2026-06-29)


### Bug Fixes

* **deps:** update non-major dependencies ([#1098](https://github.com/rotorsoft/act-root/issues/1098)) ([1d9d491](https://github.com/rotorsoft/act-root/commit/1d9d49111f86d74d79078355bb3f756ccc730e73))

# [@rotorsoft/act-sqlite-v1.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.8.0...@rotorsoft/act-sqlite-v1.9.0) (2026-06-27)


### Features

* **act:** resume with_snaps reads from the latest snapshot per stream ([959f4a8](https://github.com/rotorsoft/act-root/commit/959f4a89e8213f7e71a408bdb82b2863cbca2cdd))

# [@rotorsoft/act-sqlite-v1.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.7.0...@rotorsoft/act-sqlite-v1.8.0) (2026-06-24)


### Features

* **act:** bound the autoclose cycle with a paginated rolling sweep ([4261a81](https://github.com/rotorsoft/act-root/commit/4261a81571ea5648486a17383d633df31ff6fed5))

# [@rotorsoft/act-sqlite-v1.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.6.0...@rotorsoft/act-sqlite-v1.7.0) (2026-06-22)


### Features

* **act:** add StoreError and orchestrator circuit breaker for store failures ([71852c6](https://github.com/rotorsoft/act-root/commit/71852c6be437a64af3df49adcc582e0d7c3d7147)), closes [#984](https://github.com/rotorsoft/act-root/issues/984)

# [@rotorsoft/act-sqlite-v1.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.3...@rotorsoft/act-sqlite-v1.6.0) (2026-06-20)


### Features

* **act-tck:** run store property + concurrency contracts on durable adapters ([f5c9412](https://github.com/rotorsoft/act-root/commit/f5c9412e487a4be6be5fae551b7cdab13b28062d)), closes [#982](https://github.com/rotorsoft/act-root/issues/982)

# [@rotorsoft/act-sqlite-v1.5.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.2...@rotorsoft/act-sqlite-v1.5.3) (2026-06-20)


### Bug Fixes

* **act-tck:** pin claim() lease semantics and align pg/sqlite adapters ([86f940e](https://github.com/rotorsoft/act-root/commit/86f940e14112afa9def0876878cfc3d46562ca7b)), closes [#980](https://github.com/rotorsoft/act-root/issues/980)

# [@rotorsoft/act-sqlite-v1.5.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.1...@rotorsoft/act-sqlite-v1.5.2) (2026-06-18)


### Bug Fixes

* **deps:** update dependency @libsql/client to ^0.17.4 ([#971](https://github.com/rotorsoft/act-root/issues/971)) ([ab530de](https://github.com/rotorsoft/act-root/commit/ab530de87e980831b8f61a6fe60c7dc8cf0604cd))

# [@rotorsoft/act-sqlite-v1.5.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.5.0...@rotorsoft/act-sqlite-v1.5.1) (2026-06-11)


### Bug Fixes

* **act-pg,act-sqlite,calculator:** stackblitz-installable workspace deps ([20e1e2f](https://github.com/rotorsoft/act-root/commit/20e1e2f4fbf6e0b98f44beae250f18a09515d1c8))

# [@rotorsoft/act-sqlite-v1.5.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.2...@rotorsoft/act-sqlite-v1.5.0) (2026-06-10)


### Features

* **act-pg,act-sqlite:** [#921](https://github.com/rotorsoft/act-root/issues/921) — adapter-layer PII column encryption via @rotorsoft/act-crypto ([e0b1109](https://github.com/rotorsoft/act-root/commit/e0b11099a4fe2f333f3a2b045df1cf6728854e71))

# [@rotorsoft/act-sqlite-v1.4.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.1...@rotorsoft/act-sqlite-v1.4.2) (2026-06-07)

# [@rotorsoft/act-sqlite-v1.4.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.4.0...@rotorsoft/act-sqlite-v1.4.1) (2026-06-07)

# [@rotorsoft/act-sqlite-v1.4.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.3.0...@rotorsoft/act-sqlite-v1.4.0) (2026-05-30)


### Features

* **inspector:** restore wizard, csv viewer, dry-run preview modal ([3809025](https://github.com/rotorsoft/act-root/commit/3809025f75e79846c23e2f8da49a1a68afdeb8d1)), closes [#785](https://github.com/rotorsoft/act-root/issues/785)

# [@rotorsoft/act-sqlite-v1.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.2.0...@rotorsoft/act-sqlite-v1.3.0) (2026-05-28)


### Features

* **act:** eventsource/eventsink interfaces + csvfile + backpressured iterate util ([738f0eb](https://github.com/rotorsoft/act-root/commit/738f0eb49944b30de0363ecf406da91bbfa069f8)), closes [#788](https://github.com/rotorsoft/act-root/issues/788) [#814](https://github.com/rotorsoft/act-root/issues/814) [#784](https://github.com/rotorsoft/act-root/issues/784) [#814](https://github.com/rotorsoft/act-root/issues/814)

# [@rotorsoft/act-sqlite-v1.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.1.0...@rotorsoft/act-sqlite-v1.2.0) (2026-05-26)


### Features

* **act:** restoreoptions compaction + dry-run + progress (ACT-1125) ([51164c6](https://github.com/rotorsoft/act-root/commit/51164c6c8c33e8f4dac192d0d5c0a1120340e0b1)), closes [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#783](https://github.com/rotorsoft/act-root/issues/783) [#784](https://github.com/rotorsoft/act-root/issues/784)

# [@rotorsoft/act-sqlite-v1.1.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.0.1...@rotorsoft/act-sqlite-v1.1.0) (2026-05-25)


### Features

* **act:** store.restore port method + tck + adapter impls (ACT-1124) ([104db4b](https://github.com/rotorsoft/act-root/commit/104db4bd18389f2e14e6be96337ed9aa62b6318a)), closes [#786](https://github.com/rotorsoft/act-root/issues/786) [#784](https://github.com/rotorsoft/act-root/issues/784) [#785](https://github.com/rotorsoft/act-root/issues/785) [#784](https://github.com/rotorsoft/act-root/issues/784) [#784](https://github.com/rotorsoft/act-root/issues/784) [#789](https://github.com/rotorsoft/act-root/issues/789) [#802](https://github.com/rotorsoft/act-root/issues/802) [#783](https://github.com/rotorsoft/act-root/issues/783)

# [@rotorsoft/act-sqlite-v1.0.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v1.0.0...@rotorsoft/act-sqlite-v1.0.1) (2026-05-21)


### Bug Fixes

* **act-sqlite:** re-cut the 1.0 line as 1.0.1 after npm reserved 1.0.0 ([3d2ae10](https://github.com/rotorsoft/act-root/commit/3d2ae10a7dd450f032e20db8e3fce731712d9aa2)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)

# [@rotorsoft/act-sqlite-v1.0.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.9.0...@rotorsoft/act-sqlite-v1.0.0) (2026-05-21)


* chore(act-sqlite)!: enter 1.0 stability commitment ([1fc2846](https://github.com/rotorsoft/act-root/commit/1fc28466925d7c464877f0d413fbb80dd0f10af4)), closes [#702](https://github.com/rotorsoft/act-root/issues/702)


### BREAKING CHANGES

* This is the 1.0 release of @rotorsoft/act-sqlite. It
implements the Store contract from @rotorsoft/act 1.0 and is validated
against @rotorsoft/act-tck on @libsql/client pinned + latest in CI.
Per STABILITY.md, breaking changes to the published surface now
require a major bump.

# [@rotorsoft/act-sqlite-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.8.0...@rotorsoft/act-sqlite-v0.9.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-sqlite-v0.9.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.8.0...@rotorsoft/act-sqlite-v0.9.0) (2026-05-19)


### Features

* **act-sqlite:** wire lanes through SqliteStore and consolidate the lane contract into the TCK ([70c062b](https://github.com/rotorsoft/act-root/commit/70c062b256b273982ca9e6d155a8606020fd35e4))
* **act:** per-lane DrainController fan-out in the orchestrator ([71612ee](https://github.com/rotorsoft/act-root/commit/71612ee56ab094a57ce05de086c7a13f6be75841))

# [@rotorsoft/act-sqlite-v0.8.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.7.0...@rotorsoft/act-sqlite-v0.8.0) (2026-05-17)


### Features

* **act:** add Store.query_stats — batched per-stream aggregates ([#752](https://github.com/rotorsoft/act-root/issues/752)) ([fb1cbbc](https://github.com/rotorsoft/act-root/commit/fb1cbbcb99d02fd20bb3a6fa54ae48822f09c439)), closes [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#708](https://github.com/rotorsoft/act-root/issues/708) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639) [#639](https://github.com/rotorsoft/act-root/issues/639)

# [@rotorsoft/act-sqlite-v0.7.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.6.0...@rotorsoft/act-sqlite-v0.7.0) (2026-05-16)


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

# [@rotorsoft/act-sqlite-v0.6.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-sqlite-v0.5.2...@rotorsoft/act-sqlite-v0.6.0) (2026-05-14)


### Features

* **act-tck:** extract Store/Cache/Logger TCK package (ACT-302) ([ff9bfd4](https://github.com/rotorsoft/act-root/commit/ff9bfd44b3cf36890186c6db7965c531458953a2))

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
