# [@rotorsoft/act-tck-v1.36.18](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.17...@rotorsoft/act-tck-v1.36.18) (2026-09-05)


### Bug Fixes

* **act:** grant a zero-length lease a holder, bound reads before emitting ([#1613](https://github.com/Rotorsoft/act-root/issues/1613)) ([4c076f9](https://github.com/Rotorsoft/act-root/commit/4c076f9dddafdbf46fbfc4b627657573706c0b20)), closes [#1600](https://github.com/Rotorsoft/act-root/issues/1600)
* **act:** keep a stream's lane when the subscriber has forgotten it ([#1612](https://github.com/Rotorsoft/act-root/issues/1612)) ([2978061](https://github.com/Rotorsoft/act-root/commit/29780612c93d1fce4474baeae3dccfdf5428e386)), closes [#1598](https://github.com/Rotorsoft/act-root/issues/1598) [#1599](https://github.com/Rotorsoft/act-root/issues/1599)

# [@rotorsoft/act-tck-v1.36.17](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.16...@rotorsoft/act-tck-v1.36.17) (2026-09-05)


### Bug Fixes

* **act:** normalize omitted lanes in the dynamic lane-conflict report ([#1611](https://github.com/Rotorsoft/act-root/issues/1611)) ([826036e](https://github.com/Rotorsoft/act-root/commit/826036eab2d1697754df4ac0eeabbdc3e47311e1)), closes [#1598](https://github.com/Rotorsoft/act-root/issues/1598)

# [@rotorsoft/act-tck-v1.36.16](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.15...@rotorsoft/act-tck-v1.36.16) (2026-09-04)


### Bug Fixes

* **act:** give every Act its own ports frame ([#1609](https://github.com/Rotorsoft/act-root/issues/1609)) ([32b415a](https://github.com/Rotorsoft/act-root/commit/32b415a0177e48799844531037a3045777bb0c2d)), closes [#1597](https://github.com/Rotorsoft/act-root/issues/1597)
* **act:** unsubscribe from notify before stopping the settle loop ([#1602](https://github.com/Rotorsoft/act-root/issues/1602)) ([2e07111](https://github.com/Rotorsoft/act-root/commit/2e07111755a666dfd2ff47a629a5257ac5935b20)), closes [#1468](https://github.com/Rotorsoft/act-root/issues/1468) [#1468](https://github.com/Rotorsoft/act-root/issues/1468) [#1596](https://github.com/Rotorsoft/act-root/issues/1596)

# [@rotorsoft/act-tck-v1.36.15](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.14...@rotorsoft/act-tck-v1.36.15) (2026-08-30)


### Bug Fixes

* **act-pg:** exclude the boundary event from created_after ([#1603](https://github.com/Rotorsoft/act-root/issues/1603)) ([e8c6a18](https://github.com/Rotorsoft/act-root/commit/e8c6a182ead2c7631b1512dcd1e726dcc14a0a1a)), closes [#1595](https://github.com/Rotorsoft/act-root/issues/1595)
* **act:** revive dates on read instead of re-validating the payload ([#1601](https://github.com/Rotorsoft/act-root/issues/1601)) ([97ed5b9](https://github.com/Rotorsoft/act-root/commit/97ed5b9190601127e48d0b102c998eec95c38c78)), closes [#1594](https://github.com/Rotorsoft/act-root/issues/1594)

# [@rotorsoft/act-tck-v1.36.14](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.13...@rotorsoft/act-tck-v1.36.14) (2026-08-29)


### Bug Fixes

* **act:** don't quarantine a stream while the database is failing (ACT-1592) ([#1593](https://github.com/Rotorsoft/act-root/issues/1593)) ([25f308b](https://github.com/Rotorsoft/act-root/commit/25f308b669a4cf7a7fed0b9a394b4aaddc0c8cee)), closes [#1592](https://github.com/Rotorsoft/act-root/issues/1592)

# [@rotorsoft/act-tck-v1.36.13](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.12...@rotorsoft/act-tck-v1.36.13) (2026-08-29)


### Bug Fixes

* **act:** keep static reaction targets out of the subscribed LRU (ACT-1582) ([#1588](https://github.com/Rotorsoft/act-root/issues/1588)) ([03e132e](https://github.com/Rotorsoft/act-root/commit/03e132e4a2c557a7799684267e8a5379fa7a071c)), closes [#1582](https://github.com/Rotorsoft/act-root/issues/1582)

# [@rotorsoft/act-tck-v1.36.12](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.11...@rotorsoft/act-tck-v1.36.12) (2026-08-29)


### Bug Fixes

* **act:** key the dynamic-lane reports on the declaration, not the target ([#1587](https://github.com/Rotorsoft/act-root/issues/1587)) ([c2a3b6f](https://github.com/Rotorsoft/act-root/commit/c2a3b6f3f2a8ba39a24659e72db9bbfa67ed4e52)), closes [#1584](https://github.com/Rotorsoft/act-root/issues/1584)

# [@rotorsoft/act-tck-v1.36.11](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.10...@rotorsoft/act-tck-v1.36.11) (2026-08-27)


### Bug Fixes

* **act:** normalize the lane name on both sides of the agreement guard ([#1586](https://github.com/Rotorsoft/act-root/issues/1586)) ([088b508](https://github.com/Rotorsoft/act-root/commit/088b508d1b56bb3fdaba5253fb78bf3c678bf9a8)), closes [#1583](https://github.com/Rotorsoft/act-root/issues/1583)

# [@rotorsoft/act-tck-v1.36.10](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.9...@rotorsoft/act-tck-v1.36.10) (2026-08-27)


### Bug Fixes

* **act:** warn instead of error on self-healing failures ([#1580](https://github.com/Rotorsoft/act-root/issues/1580)) ([85c29ea](https://github.com/Rotorsoft/act-root/commit/85c29eaf935be2df4c3ab01d18c4383db81c5a0b)), closes [#1579](https://github.com/Rotorsoft/act-root/issues/1579)

# [@rotorsoft/act-tck-v1.36.9](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.8...@rotorsoft/act-tck-v1.36.9) (2026-08-27)


### Bug Fixes

* **act:** explain a failed correlation-lease handback instead of logging it raw ([#1578](https://github.com/Rotorsoft/act-root/issues/1578)) ([7a64bd9](https://github.com/Rotorsoft/act-root/commit/7a64bd987a7161e02caac4e5842435b0290fd9bb)), closes [#1577](https://github.com/Rotorsoft/act-root/issues/1577) [#1577](https://github.com/Rotorsoft/act-root/issues/1577)

# [@rotorsoft/act-tck-v1.36.8](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.7...@rotorsoft/act-tck-v1.36.8) (2026-08-25)


### Bug Fixes

* **act:** apply the lane guards to dynamic resolutions ([#1575](https://github.com/Rotorsoft/act-root/issues/1575)) ([f3d5781](https://github.com/Rotorsoft/act-root/commit/f3d578139993cbe92b39dc11c4d4142d03bef6de)), closes [#1420](https://github.com/Rotorsoft/act-root/issues/1420) [#1564](https://github.com/Rotorsoft/act-root/issues/1564) [#1567](https://github.com/Rotorsoft/act-root/issues/1567)

# [@rotorsoft/act-tck-v1.36.7](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.6...@rotorsoft/act-tck-v1.36.7) (2026-08-25)


### Bug Fixes

* **act:** stop a dynamic resolution from hijacking a projection's target ([#1571](https://github.com/Rotorsoft/act-root/issues/1571)) ([0f53541](https://github.com/Rotorsoft/act-root/commit/0f53541db8988c389c415c930cdee006937250ca)), closes [#1563](https://github.com/Rotorsoft/act-root/issues/1563) [#1563](https://github.com/Rotorsoft/act-root/issues/1563)

# [@rotorsoft/act-tck-v1.36.6](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.5...@rotorsoft/act-tck-v1.36.6) (2026-08-25)


### Bug Fixes

* **act:** let the schema decide which fields are dates ([#1570](https://github.com/Rotorsoft/act-root/issues/1570)) ([dca2166](https://github.com/Rotorsoft/act-root/commit/dca2166ad756b39dbb5b6287057fc67c5222a5e6)), closes [#1556](https://github.com/Rotorsoft/act-root/issues/1556)

# [@rotorsoft/act-tck-v1.36.5](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.4...@rotorsoft/act-tck-v1.36.5) (2026-08-25)


### Bug Fixes

* **act:** stop treating work that outlived a handler as a reaction ([#1568](https://github.com/Rotorsoft/act-root/issues/1568)) ([bff17a2](https://github.com/Rotorsoft/act-root/commit/bff17a230371a4a181f42c077a31ae5c6e8b3bc3)), closes [#1541](https://github.com/Rotorsoft/act-root/issues/1541) [#1543](https://github.com/Rotorsoft/act-root/issues/1543) [#1543](https://github.com/Rotorsoft/act-root/issues/1543) [#1562](https://github.com/Rotorsoft/act-root/issues/1562) [#1562](https://github.com/Rotorsoft/act-root/issues/1562)

# [@rotorsoft/act-tck-v1.36.4](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.3...@rotorsoft/act-tck-v1.36.4) (2026-08-24)


### Bug Fixes

* **deps:** update non-major dependencies ([#1558](https://github.com/Rotorsoft/act-root/issues/1558)) ([5f5b2a6](https://github.com/Rotorsoft/act-root/commit/5f5b2a6b965dcc4298fb7d12c7af5b622a9674de))

# [@rotorsoft/act-tck-v1.36.3](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.2...@rotorsoft/act-tck-v1.36.3) (2026-08-23)

# [@rotorsoft/act-tck-v1.36.2](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.1...@rotorsoft/act-tck-v1.36.2) (2026-08-23)


### Bug Fixes

* **act:** keep the claim lane filter when onlyLanes narrows to default ([#1548](https://github.com/Rotorsoft/act-root/issues/1548)) ([2e7b07b](https://github.com/Rotorsoft/act-root/commit/2e7b07b454875ff08e3fd2ffa2b43f070859e1ef)), closes [#1545](https://github.com/Rotorsoft/act-root/issues/1545)

# [@rotorsoft/act-tck-v1.36.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.36.0...@rotorsoft/act-tck-v1.36.1) (2026-08-23)


### Bug Fixes

* **act:** honor an explicit expectedVersion inside a reaction ([#1544](https://github.com/Rotorsoft/act-root/issues/1544)) ([ad8ec6e](https://github.com/Rotorsoft/act-root/commit/ad8ec6e9fe3b860c801cd22131cf4897ad83832c)), closes [#1541](https://github.com/Rotorsoft/act-root/issues/1541) [#1543](https://github.com/Rotorsoft/act-root/issues/1543)

# [@rotorsoft/act-tck-v1.36.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.35.0...@rotorsoft/act-tck-v1.36.0) (2026-08-22)


### Features

* **act:** one worker reads the event log for all of them ([#1537](https://github.com/Rotorsoft/act-root/issues/1537)) ([6cb58f3](https://github.com/Rotorsoft/act-root/commit/6cb58f35dcee98ce1c96053bc73fcb54e111d986))

# [@rotorsoft/act-tck-v1.35.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.34.4...@rotorsoft/act-tck-v1.35.0) (2026-08-21)


### Features

* **act:** truncate no longer removes subscriptions ([463cab3](https://github.com/Rotorsoft/act-root/commit/463cab3ed1d60ec932fb5945856121385998cb67))

# [@rotorsoft/act-tck-v1.34.4](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.34.3...@rotorsoft/act-tck-v1.34.4) (2026-08-20)


### Bug Fixes

* **inspector:** report pending work, not distance to the head ([#1528](https://github.com/Rotorsoft/act-root/issues/1528)) ([7d9e830](https://github.com/Rotorsoft/act-root/commit/7d9e830650e56f8666c403854b93a0178a5c62d9)), closes [#1521](https://github.com/Rotorsoft/act-root/issues/1521)

# [@rotorsoft/act-tck-v1.34.3](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.34.2...@rotorsoft/act-tck-v1.34.3) (2026-08-20)


### Bug Fixes

* **act:** cap a windowed prune at pending work, not watermark lag ([#1525](https://github.com/Rotorsoft/act-root/issues/1525)) ([365d185](https://github.com/Rotorsoft/act-root/commit/365d1855a96e5543341c637f9ba572e76087cced)), closes [#1520](https://github.com/Rotorsoft/act-root/issues/1520)

# [@rotorsoft/act-tck-v1.34.2](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.34.1...@rotorsoft/act-tck-v1.34.2) (2026-08-20)


### Performance Improvements

* **act-pg:** stop materializing the eligible set in claim (91ms → 1.5ms) ([#1518](https://github.com/Rotorsoft/act-root/issues/1518)) ([16735a9](https://github.com/Rotorsoft/act-root/commit/16735a9d3a18b436323368630308b3c2a4e1f02f)), closes [#1485](https://github.com/Rotorsoft/act-root/issues/1485) [#1488](https://github.com/Rotorsoft/act-root/issues/1488) [#1517](https://github.com/Rotorsoft/act-root/issues/1517) [#1329](https://github.com/Rotorsoft/act-root/issues/1329) [#1519](https://github.com/Rotorsoft/act-root/issues/1519)
* **act:** let correlate sit still when nothing has happened ([#1517](https://github.com/Rotorsoft/act-root/issues/1517)) ([5e33afd](https://github.com/Rotorsoft/act-root/commit/5e33afd4096444013c5f58b2d7dfb64f30841861)), closes [#1329](https://github.com/Rotorsoft/act-root/issues/1329)

# [@rotorsoft/act-tck-v1.34.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.34.0...@rotorsoft/act-tck-v1.34.1) (2026-08-18)


### Bug Fixes

* **act-http:** keep the sse subpath importable from a browser ([#1514](https://github.com/Rotorsoft/act-root/issues/1514)) ([42050e0](https://github.com/Rotorsoft/act-root/commit/42050e03d1f7117df6bac16a63c1ea89505d6ab5)), closes [#1423](https://github.com/Rotorsoft/act-root/issues/1423) [#1423](https://github.com/Rotorsoft/act-root/issues/1423)

# [@rotorsoft/act-tck-v1.34.0](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.33.1...@rotorsoft/act-tck-v1.34.0) (2026-08-18)


### Features

* **act:** claim reads the work mark and nothing else ([#1511](https://github.com/Rotorsoft/act-root/issues/1511)) ([579c775](https://github.com/Rotorsoft/act-root/commit/579c7751f66a51eacb374bb6350d51c869af093c)), closes [#1446](https://github.com/Rotorsoft/act-root/issues/1446) [#1510](https://github.com/Rotorsoft/act-root/issues/1510)

# [@rotorsoft/act-tck-v1.33.1](https://github.com/Rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.33.0...@rotorsoft/act-tck-v1.33.1) (2026-08-18)


### Bug Fixes

* **act:** match GitHub's owner casing in repository.url ([a719f54](https://github.com/Rotorsoft/act-root/commit/a719f548acb22cd303a229a4c4dafbf8f8e4f5b7))

# [@rotorsoft/act-tck-v1.33.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.32.0...@rotorsoft/act-tck-v1.33.0) (2026-08-18)


### Features

* **act:** correlate becomes the universal producer of the work mark ([#1497](https://github.com/rotorsoft/act-root/issues/1497)) ([0fe7380](https://github.com/rotorsoft/act-root/commit/0fe7380f2d5dc94080b24776f3bd6ca46a55d603)), closes [#1496](https://github.com/rotorsoft/act-root/issues/1496) [#1487](https://github.com/rotorsoft/act-root/issues/1487)

# [@rotorsoft/act-tck-v1.32.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.31.0...@rotorsoft/act-tck-v1.32.0) (2026-08-16)


### Features

* **act:** subscription work set — claim reads eligibility off the subscription row ([#1496](https://github.com/rotorsoft/act-root/issues/1496)) ([d31452c](https://github.com/rotorsoft/act-root/commit/d31452c823cda9ed90d9e50f23cee0443978dead)), closes [#1484](https://github.com/rotorsoft/act-root/issues/1484)

# [@rotorsoft/act-tck-v1.31.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.5...@rotorsoft/act-tck-v1.31.0) (2026-08-16)


### Features

* **act:** make the correlate checkpoint durable ([#1493](https://github.com/rotorsoft/act-root/issues/1493)) ([bea07fb](https://github.com/rotorsoft/act-root/commit/bea07fba0822371cd730108bd917c9e289001321)), closes [#1484](https://github.com/rotorsoft/act-root/issues/1484) [#1484](https://github.com/rotorsoft/act-root/issues/1484)

# [@rotorsoft/act-tck-v1.30.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.4...@rotorsoft/act-tck-v1.30.5) (2026-08-15)


### Bug Fixes

* **act-http:** overlay state survives a commit ([7f89bb7](https://github.com/rotorsoft/act-root/commit/7f89bb7aba968bdd7f86f3b77a3bf2c84c02bf68)), closes [#1479](https://github.com/rotorsoft/act-root/issues/1479) [#1473](https://github.com/rotorsoft/act-root/issues/1473)
* **act-http:** pin three documented SSE guarantees that nothing enforced ([47a2d0a](https://github.com/rotorsoft/act-root/commit/47a2d0af5f5ca4cfda78a0643c52a20b4b04c990)), closes [#1474](https://github.com/rotorsoft/act-root/issues/1474)

# [@rotorsoft/act-tck-v1.30.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.3...@rotorsoft/act-tck-v1.30.4) (2026-08-15)


### Bug Fixes

* **act-http:** broadcast a Set as an array on both wire paths ([b82cf1f](https://github.com/rotorsoft/act-root/commit/b82cf1faabfe72ee451f777ec4772f26fd7a7b17)), closes [#1472](https://github.com/rotorsoft/act-root/issues/1472)
* **act:** complete the target-ownership guard and make it identity-aware ([0b11c0f](https://github.com/rotorsoft/act-root/commit/0b11c0f3478bc7ea31e124564640139a99c78461)), closes [#1467](https://github.com/rotorsoft/act-root/issues/1467) [#1469](https://github.com/rotorsoft/act-root/issues/1469) [#1467](https://github.com/rotorsoft/act-root/issues/1467) [#1469](https://github.com/rotorsoft/act-root/issues/1469)
* **act:** shutdown awaits the in-flight settle cycle ([53746a4](https://github.com/rotorsoft/act-root/commit/53746a4e98a915507a2bfaefa5c0958f397ffaeb)), closes [#1468](https://github.com/rotorsoft/act-root/issues/1468)

# [@rotorsoft/act-tck-v1.30.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.2...@rotorsoft/act-tck-v1.30.3) (2026-08-14)


### Bug Fixes

* **act-http:** normalize undefined deletes to null in SSE frames ([048a1f0](https://github.com/rotorsoft/act-root/commit/048a1f01c23cce1538d0c02ba7d6a7d7cf2b4e4f)), closes [#1471](https://github.com/rotorsoft/act-root/issues/1471)
* **act:** fold forward only across a contiguous version step ([0dfc0e1](https://github.com/rotorsoft/act-root/commit/0dfc0e1a8d2e2ef2890b055e4f22817ce71a5f32)), closes [#1372](https://github.com/rotorsoft/act-root/issues/1372) [#1465](https://github.com/rotorsoft/act-root/issues/1465) [#1466](https://github.com/rotorsoft/act-root/issues/1466)

# [@rotorsoft/act-tck-v1.30.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.1...@rotorsoft/act-tck-v1.30.2) (2026-08-13)


### Bug Fixes

* **act:** claim follows work, not registration, on every adapter ([151646b](https://github.com/rotorsoft/act-root/commit/151646b80fb5029b8e63beb34c6efe24aaee8326)), closes [#1446](https://github.com/rotorsoft/act-root/issues/1446)

# [@rotorsoft/act-tck-v1.30.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.30.0...@rotorsoft/act-tck-v1.30.1) (2026-08-13)


### Bug Fixes

* **act-sqlite:** apply the priority max-merge to non-positive values ([a272abb](https://github.com/rotorsoft/act-root/commit/a272abbfd3838184d1ece44a201f509ca81b4c2e)), closes [#1445](https://github.com/rotorsoft/act-root/issues/1445)

# [@rotorsoft/act-tck-v1.30.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.29.1...@rotorsoft/act-tck-v1.30.0) (2026-08-13)


### Features

* **act:** give shutdown a bounded wait for in-flight drain cycles ([c806471](https://github.com/rotorsoft/act-root/commit/c8064712c7fae5b3493fae284116cc4b0bd609ba)), closes [#1418](https://github.com/rotorsoft/act-root/issues/1418) [#1442](https://github.com/rotorsoft/act-root/issues/1442)

# [@rotorsoft/act-tck-v1.29.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.29.0...@rotorsoft/act-tck-v1.29.1) (2026-08-12)


### Bug Fixes

* **act:** stop pinning every Act in the dispose registry ([955ed6b](https://github.com/rotorsoft/act-root/commit/955ed6bb9f66eeb506cd8acf6d490f80596ca0fa)), closes [#1441](https://github.com/rotorsoft/act-root/issues/1441)

# [@rotorsoft/act-tck-v1.29.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.6...@rotorsoft/act-tck-v1.29.0) (2026-08-11)


### Bug Fixes

* **act-sqlite:** require an explicit url and repair in-memory ([5d1383b](https://github.com/rotorsoft/act-root/commit/5d1383b6c5235581be07891b6637016fe8ecce7d)), closes [#1443](https://github.com/rotorsoft/act-root/issues/1443)


### Features

* **act-tck:** cover an adapter's own default config ([b622a96](https://github.com/rotorsoft/act-root/commit/b622a960a354b7b4618452b828cbb12a67f8a8a9)), closes [#1443](https://github.com/rotorsoft/act-root/issues/1443)

# [@rotorsoft/act-tck-v1.28.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.5...@rotorsoft/act-tck-v1.28.6) (2026-08-11)


### Bug Fixes

* **act:** contain the cache invalidate on the ConcurrencyError path ([fe9b529](https://github.com/rotorsoft/act-root/commit/fe9b5299b5d6996043e7c014755e5d34be0961cc))
* **act:** reject a projection target claimed twice, in all four pairings ([e632ab7](https://github.com/rotorsoft/act-root/commit/e632ab70baf7f92273674adf5c2e67077ed477ae))

# [@rotorsoft/act-tck-v1.28.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.4...@rotorsoft/act-tck-v1.28.5) (2026-08-09)


### Bug Fixes

* **act:** contain lifecycle listeners in Act.emit, per listener ([8ab9bed](https://github.com/rotorsoft/act-root/commit/8ab9bedca3181a4c7300f476aa57540624aae043)), closes [#1423](https://github.com/rotorsoft/act-root/issues/1423)

# [@rotorsoft/act-tck-v1.28.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.3...@rotorsoft/act-tck-v1.28.4) (2026-08-09)


### Performance Improvements

* **act-pg:** make claim's has-work probe sargable and index it ([2276fc1](https://github.com/rotorsoft/act-root/commit/2276fc109246bd51deb56d5825a332ee697b24df))

# [@rotorsoft/act-tck-v1.28.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.2...@rotorsoft/act-tck-v1.28.3) (2026-08-09)


### Bug Fixes

* **act:** contain a throwing settled listener so it cannot open the breaker ([496c9ad](https://github.com/rotorsoft/act-root/commit/496c9adc6bc9c3f0d340dcd52256883cc3702f6a))

# [@rotorsoft/act-tck-v1.28.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.1...@rotorsoft/act-tck-v1.28.2) (2026-08-09)


### Bug Fixes

* **act-pg:** translate Postgres NUL-byte refusals into a ValidationError ([188d71b](https://github.com/rotorsoft/act-root/commit/188d71b14153d69021a97de4cad47df40de1156a)), closes [#1422](https://github.com/rotorsoft/act-root/issues/1422) [#1422](https://github.com/rotorsoft/act-root/issues/1422)
* **act-pg:** widen id to bigserial, and reject NUL bytes in core ([3ec323b](https://github.com/rotorsoft/act-root/commit/3ec323bc581526eb0815a3c9c4b2c614f61c7876)), closes [#1140](https://github.com/rotorsoft/act-root/issues/1140) [#1422](https://github.com/rotorsoft/act-root/issues/1422)

# [@rotorsoft/act-tck-v1.28.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.28.0...@rotorsoft/act-tck-v1.28.1) (2026-08-08)


### Bug Fixes

* **act:** block a stream whose lease is lost every round ([340e24f](https://github.com/rotorsoft/act-root/commit/340e24f698b09b015a9ca48e7c09e80d249d7692)), closes [#1418](https://github.com/rotorsoft/act-root/issues/1418)
* **act:** report acks dropped by a stolen lease ([b648b23](https://github.com/rotorsoft/act-root/commit/b648b23c06d10ff546e97e6aa5104b469cb37569)), closes [#1418](https://github.com/rotorsoft/act-root/issues/1418)

# [@rotorsoft/act-tck-v1.28.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.43...@rotorsoft/act-tck-v1.28.0) (2026-08-08)


### Features

* **act-http:** emit a resync frame when overlay loses its baseline ([b03d7e7](https://github.com/rotorsoft/act-root/commit/b03d7e70736a0fbd009022f99e6fb14f7b4c9d30)), closes [#1419](https://github.com/rotorsoft/act-root/issues/1419) [1346/#1419](https://github.com/rotorsoft/act-root/issues/1419) [#1423](https://github.com/rotorsoft/act-root/issues/1423)

# [@rotorsoft/act-tck-v1.27.43](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.42...@rotorsoft/act-tck-v1.27.43) (2026-08-08)


### Bug Fixes

* **act-http:** contain throwing SSE subscribers and surface overlay cache misses ([8a0f27e](https://github.com/rotorsoft/act-root/commit/8a0f27e5dafd8355bd5c337cd92b7e32d1b237dc)), closes [#1423](https://github.com/rotorsoft/act-root/issues/1423)
* **act:** mask sensitive keys before the audit schema parse ([b2c5b76](https://github.com/rotorsoft/act-root/commit/b2c5b76558d988b67404a983a68b7061c12d9ffd)), closes [#1417](https://github.com/rotorsoft/act-root/issues/1417) [#1310](https://github.com/rotorsoft/act-root/issues/1310) [#1424](https://github.com/rotorsoft/act-root/issues/1424)

# [@rotorsoft/act-tck-v1.27.42](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.41...@rotorsoft/act-tck-v1.27.42) (2026-08-08)


### Bug Fixes

* **act-pg:** take a schema-scoped advisory lock around CREATE SCHEMA ([79d585d](https://github.com/rotorsoft/act-root/commit/79d585d807ddda13d437036dee214d43dd58af8e)), closes [#1421](https://github.com/rotorsoft/act-root/issues/1421)

# [@rotorsoft/act-tck-v1.27.41](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.40...@rotorsoft/act-tck-v1.27.41) (2026-08-08)


### Bug Fixes

* **act-http:** classify overlay frames exhaustively before the fold ([409c86e](https://github.com/rotorsoft/act-root/commit/409c86e687fce7629832f70a16ac5bfa08c5a988)), closes [#1312](https://github.com/rotorsoft/act-root/issues/1312) [#1346](https://github.com/rotorsoft/act-root/issues/1346) [#1419](https://github.com/rotorsoft/act-root/issues/1419)
* **act-pg:** widen stream/source/name to text so derived identifiers fit ([ef4bd11](https://github.com/rotorsoft/act-root/commit/ef4bd1153a2845eeb9a5158a3a431c526a9e8c9e)), closes [#1190](https://github.com/rotorsoft/act-root/issues/1190) [#1420](https://github.com/rotorsoft/act-root/issues/1420)
* **act:** keep the sensitive() marker through refinements and unions ([4d3696d](https://github.com/rotorsoft/act-root/commit/4d3696d21ef2007cb734209a75e0c224a57b97bf)), closes [#1277](https://github.com/rotorsoft/act-root/issues/1277) [1397/#1405](https://github.com/rotorsoft/act-root/issues/1405) [#1417](https://github.com/rotorsoft/act-root/issues/1417)

# [@rotorsoft/act-tck-v1.27.40](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.39...@rotorsoft/act-tck-v1.27.40) (2026-08-08)


### Bug Fixes

* **act:** keep a restarted stream's subscription and forget a retired one ([5b57672](https://github.com/rotorsoft/act-root/commit/5b57672dbe44d78e3deac16be8fcc9fb90118b19)), closes [#1363](https://github.com/rotorsoft/act-root/issues/1363) [#1398](https://github.com/rotorsoft/act-root/issues/1398)

# [@rotorsoft/act-tck-v1.27.39](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.38...@rotorsoft/act-tck-v1.27.39) (2026-08-07)


### Bug Fixes

* **act:** make correlate init retryable after a transient store failure ([9d53ee6](https://github.com/rotorsoft/act-root/commit/9d53ee64cd5eefebee08dae059c0253050c981d8)), closes [#1387](https://github.com/rotorsoft/act-root/issues/1387)
* **act:** resume an interrupted close instead of dropping it from the scan ([fca684c](https://github.com/rotorsoft/act-root/commit/fca684cac08de3def90a1bbaab3ebafbdd41722e)), closes [#1389](https://github.com/rotorsoft/act-root/issues/1389)

# [@rotorsoft/act-tck-v1.27.38](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.37...@rotorsoft/act-tck-v1.27.38) (2026-08-07)


### Bug Fixes

* **act:** refuse a restart close on a sensitive-bearing state before any write ([e436005](https://github.com/rotorsoft/act-root/commit/e436005cdf9bd86585e9e52f0d429a2b3fef72d8)), closes [#1397](https://github.com/rotorsoft/act-root/issues/1397)
* **act:** refuse restart seeding for a sensitive-bearing state ([881b3f8](https://github.com/rotorsoft/act-root/commit/881b3f8a646912c633c7a0cd174789da7c7f8b34)), closes [#1397](https://github.com/rotorsoft/act-root/issues/1397)

# [@rotorsoft/act-tck-v1.27.37](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.36...@rotorsoft/act-tck-v1.27.37) (2026-08-07)


### Bug Fixes

* **act:** emit blocked when block confirms, not at the end of the cycle ([0cbc80d](https://github.com/rotorsoft/act-root/commit/0cbc80d31152eb6a6671c230f0751f82a0665369)), closes [#1373](https://github.com/rotorsoft/act-root/issues/1373) [#1296](https://github.com/rotorsoft/act-root/issues/1296) [#1373](https://github.com/rotorsoft/act-root/issues/1373) [#1390](https://github.com/rotorsoft/act-root/issues/1390)
* **act:** let store failures inside on_close reach the circuit breaker ([46a912f](https://github.com/rotorsoft/act-root/commit/46a912f51ec48c9278cd3c3db51a7bc5631b6fdd)), closes [#1376](https://github.com/rotorsoft/act-root/issues/1376) [pre-#1376](https://github.com/pre-/issues/1376) [#1376](https://github.com/rotorsoft/act-root/issues/1376) [#1388](https://github.com/rotorsoft/act-root/issues/1388)

# [@rotorsoft/act-tck-v1.27.36](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.35...@rotorsoft/act-tck-v1.27.36) (2026-08-07)


### Bug Fixes

* **act:** revive dates when reading data and meta from a CSV ([b2a8122](https://github.com/rotorsoft/act-root/commit/b2a81220e50210b5b91ca5f7c39bc64fcf73c101)), closes [#1380](https://github.com/rotorsoft/act-root/issues/1380) [#1399](https://github.com/rotorsoft/act-root/issues/1399)

# [@rotorsoft/act-tck-v1.27.35](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.34...@rotorsoft/act-tck-v1.27.35) (2026-08-06)


### Bug Fixes

* **act-sqlite:** return the post-block row from block(), not the caller's lease ([0555d07](https://github.com/rotorsoft/act-root/commit/0555d07329e4f192161bf4bd36d379e2d6607716)), closes [#1347](https://github.com/rotorsoft/act-root/issues/1347) [#1382](https://github.com/rotorsoft/act-root/issues/1382)

# [@rotorsoft/act-tck-v1.27.34](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.33...@rotorsoft/act-tck-v1.27.34) (2026-08-06)


### Bug Fixes

* **act:** accumulate the settle's passes into the settled payload ([fc67a85](https://github.com/rotorsoft/act-root/commit/fc67a85324b513ac21515927e40c124478334c84)), closes [#1383](https://github.com/rotorsoft/act-root/issues/1383)

# [@rotorsoft/act-tck-v1.27.33](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.32...@rotorsoft/act-tck-v1.27.33) (2026-08-06)


### Bug Fixes

* **act-crypto:** revive dates when decrypting pii payloads ([1a79178](https://github.com/rotorsoft/act-root/commit/1a7917883db522b5fba9935ceef99f15fe8de6ec)), closes [#1365](https://github.com/rotorsoft/act-root/issues/1365) [#1370](https://github.com/rotorsoft/act-root/issues/1370) [#1365](https://github.com/rotorsoft/act-root/issues/1365)

# [@rotorsoft/act-tck-v1.27.32](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.31...@rotorsoft/act-tck-v1.27.32) (2026-08-06)


### Bug Fixes

* **act:** resolve domain stream heads in audit by excluding __snapshot__ ([f2f096b](https://github.com/rotorsoft/act-root/commit/f2f096ba5c0b1f5032a4893fdb148c15afc340ab)), closes [#1374](https://github.com/rotorsoft/act-root/issues/1374)

# [@rotorsoft/act-tck-v1.27.31](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.30...@rotorsoft/act-tck-v1.27.31) (2026-08-06)


### Bug Fixes

* **act:** build state-projection fold handlers per Act, not per builder ([fb27b00](https://github.com/rotorsoft/act-root/commit/fb27b004d61a167ca8937c8be2ea0b4c2cc2b226)), closes [#1369](https://github.com/rotorsoft/act-root/issues/1369)
* **act:** match InMemory query_streams sort comparator to its cursor ([c3cb14d](https://github.com/rotorsoft/act-root/commit/c3cb14dd0f6d53f01df2966467ff8425a9a91524)), closes [#1357](https://github.com/rotorsoft/act-root/issues/1357) [#1375](https://github.com/rotorsoft/act-root/issues/1375)

# [@rotorsoft/act-tck-v1.27.30](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.29...@rotorsoft/act-tck-v1.27.30) (2026-08-06)


### Bug Fixes

* **act:** contain throwing lifecycle listeners in the drain finalize path ([c39d2e8](https://github.com/rotorsoft/act-root/commit/c39d2e8ed8f01ab5ec46b4e4427fffc7e640b492)), closes [#1373](https://github.com/rotorsoft/act-root/issues/1373)
* **act:** page the audit and defer-reseed stream walks ([7393a24](https://github.com/rotorsoft/act-root/commit/7393a24552e64e58f718111b294c778df9768a7b)), closes [#1371](https://github.com/rotorsoft/act-root/issues/1371)

# [@rotorsoft/act-tck-v1.27.29](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.28...@rotorsoft/act-tck-v1.27.29) (2026-08-05)


### Bug Fixes

* **act-http:** receiver auto-finalize releases on 4xx, not just 5xx ([52c6ee5](https://github.com/rotorsoft/act-root/commit/52c6ee54079997bbd703efa6acc6b049de3e87f8)), closes [#1364](https://github.com/rotorsoft/act-root/issues/1364)
* **act-sqlite:** revive a Date in a pii field on read, matching data/meta ([fca5ed8](https://github.com/rotorsoft/act-root/commit/fca5ed86268a4dd0015549f9f9abf1b42026726e)), closes [#1198](https://github.com/rotorsoft/act-root/issues/1198) [#1198](https://github.com/rotorsoft/act-root/issues/1198) [#1365](https://github.com/rotorsoft/act-root/issues/1365)
* **act:** dynamic-resolver target priority upgrades across correlate scans ([695ce15](https://github.com/rotorsoft/act-root/commit/695ce159a72e8f6e0fcad814827d10757ab0cfa8)), closes [should-be-hi#priority](https://github.com/should-be-hi/issues/priority) [#1363](https://github.com/rotorsoft/act-root/issues/1363)

# [@rotorsoft/act-tck-v1.27.28](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.27...@rotorsoft/act-tck-v1.27.28) (2026-08-04)


### Bug Fixes

* **act:** reset/defer array form counts distinct streams, matching PG ([bcb911a](https://github.com/rotorsoft/act-root/commit/bcb911a3132777b16e0ec06c75b009baf1db9f47)), closes [#1360](https://github.com/rotorsoft/act-root/issues/1360)

# [@rotorsoft/act-tck-v1.27.27](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.26...@rotorsoft/act-tck-v1.27.27) (2026-08-04)


### Bug Fixes

* **act:** autoclose fires when a snapshot trails the terminal event ([4e9419c](https://github.com/rotorsoft/act-root/commit/4e9419c3ac83f586d938786c8896102269b503ad)), closes [#1356](https://github.com/rotorsoft/act-root/issues/1356)
* **act:** query_stats pagination uses code-unit sort matching its cursor ([bbac425](https://github.com/rotorsoft/act-root/commit/bbac4255e2bc23a7e3f010955fff869b5fd1f44d)), closes [#1357](https://github.com/rotorsoft/act-root/issues/1357)

# [@rotorsoft/act-tck-v1.27.26](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.25...@rotorsoft/act-tck-v1.27.26) (2026-08-03)


### Bug Fixes

* **deps:** update non-major dependencies ([f3b63d9](https://github.com/rotorsoft/act-root/commit/f3b63d98d9b9e262765700c503d55eec28c290cd))

# [@rotorsoft/act-tck-v1.27.25](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.24...@rotorsoft/act-tck-v1.27.25) (2026-08-02)


### Bug Fixes

* **act-http:** apply SSE genesis event (version 0) for a fresh client ([9f3c0a1](https://github.com/rotorsoft/act-root/commit/9f3c0a1244234dd5d13553f926a4af780bf1dadc)), closes [#1346](https://github.com/rotorsoft/act-root/issues/1346)
* **act-sqlite:** ack returns authoritative retry -1, not the stale input echo ([a9014e7](https://github.com/rotorsoft/act-root/commit/a9014e71dbf6a8c64fc8c64d150f8798f65a913b)), closes [#1347](https://github.com/rotorsoft/act-root/issues/1347)

# [@rotorsoft/act-tck-v1.27.24](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.23...@rotorsoft/act-tck-v1.27.24) (2026-07-30)


### Bug Fixes

* **act-ops:** protect committed keys and gc on commit/release ([7d9fe58](https://github.com/rotorsoft/act-root/commit/7d9fe58d0700998d756de947a3a6682e7d332882)), closes [#1335](https://github.com/rotorsoft/act-root/issues/1335) [#1336](https://github.com/rotorsoft/act-root/issues/1336) [#1335](https://github.com/rotorsoft/act-root/issues/1335) [#1336](https://github.com/rotorsoft/act-root/issues/1336)

# [@rotorsoft/act-tck-v1.27.23](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.22...@rotorsoft/act-tck-v1.27.23) (2026-07-25)


### Bug Fixes

* **act:** record a settle circuit-breaker success only on a real store probe ([d528966](https://github.com/rotorsoft/act-root/commit/d52896621dcb03b22f564bf718c286441a8787fc)), closes [#1309](https://github.com/rotorsoft/act-root/issues/1309) [#1329](https://github.com/rotorsoft/act-root/issues/1329)

# [@rotorsoft/act-tck-v1.27.22](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.21...@rotorsoft/act-tck-v1.27.22) (2026-07-23)


### Bug Fixes

* **act:** enforce lane agreement per-target, not per (target, source) ([76c9839](https://github.com/rotorsoft/act-root/commit/76c9839a8605c7a2d864e31927b9953245562524)), closes [#1325](https://github.com/rotorsoft/act-root/issues/1325)

# [@rotorsoft/act-tck-v1.27.21](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.20...@rotorsoft/act-tck-v1.27.21) (2026-07-23)


### Bug Fixes

* **act:** strip PII on the fold engine's cold path like the warm path ([97583f9](https://github.com/rotorsoft/act-root/commit/97583f9cd6d162d979065a6c1bdbb22754523e5d)), closes [#1320](https://github.com/rotorsoft/act-root/issues/1320)

# [@rotorsoft/act-tck-v1.27.20](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.19...@rotorsoft/act-tck-v1.27.20) (2026-07-22)


### Bug Fixes

* **act-http:** mark SSE overlay frames so live clients apply them ([d8f4070](https://github.com/rotorsoft/act-root/commit/d8f4070e5ab5c9f5d1597e342c75f88c1535415c)), closes [#1312](https://github.com/rotorsoft/act-root/issues/1312)

# [@rotorsoft/act-tck-v1.27.19](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.18...@rotorsoft/act-tck-v1.27.19) (2026-07-21)


### Bug Fixes

* **act-otel:** sum streams_blocked across every app on a shared registry ([b20b57b](https://github.com/rotorsoft/act-root/commit/b20b57b85148e36f3ab07784f27d12cb7ae59f5e)), closes [#1313](https://github.com/rotorsoft/act-root/issues/1313)

# [@rotorsoft/act-tck-v1.27.18](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.17...@rotorsoft/act-tck-v1.27.18) (2026-07-21)


### Bug Fixes

* **act-http:** map tRPC malformed body to 422 via in-resolver validation ([c2517ea](https://github.com/rotorsoft/act-root/commit/c2517ea68a7521b2da90e658ebbd3697ada40693)), closes [#1295](https://github.com/rotorsoft/act-root/issues/1295)

# [@rotorsoft/act-tck-v1.27.17](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.16...@rotorsoft/act-tck-v1.27.17) (2026-07-21)


### Bug Fixes

* **act-http:** finalize receiver deliveries through the guarded finalizers ([aea5c68](https://github.com/rotorsoft/act-root/commit/aea5c6813d56faf9a6187210030e96c7a16b9dd5)), closes [#1293](https://github.com/rotorsoft/act-root/issues/1293)

# [@rotorsoft/act-tck-v1.27.16](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.15...@rotorsoft/act-tck-v1.27.16) (2026-07-21)


### Bug Fixes

* **act-sqlite:** omit pii from query_stats head/tail ([7a78379](https://github.com/rotorsoft/act-root/commit/7a78379df438cc2da19e11d20183f62e84fe52f1)), closes [#1294](https://github.com/rotorsoft/act-root/issues/1294)
* **act:** block before ack so partial-progress-then-block lands the block ([7d59322](https://github.com/rotorsoft/act-root/commit/7d593229ca3cee55b6d10ed99a4098b79fcedbc9)), closes [#1296](https://github.com/rotorsoft/act-root/issues/1296)

# [@rotorsoft/act-tck-v1.27.15](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.14...@rotorsoft/act-tck-v1.27.15) (2026-07-20)


### Bug Fixes

* **deps:** update non-major dependencies ([#1299](https://github.com/rotorsoft/act-root/issues/1299)) ([c96d8a0](https://github.com/rotorsoft/act-root/commit/c96d8a0745614da530ed4d7d2c1299e1e4120660))

# [@rotorsoft/act-tck-v1.27.14](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.13...@rotorsoft/act-tck-v1.27.14) (2026-07-19)


### Bug Fixes

* **act-http:** mark the OpenAPI Idempotency-Key header required ([#1287](https://github.com/rotorsoft/act-root/issues/1287)) ([3261f3e](https://github.com/rotorsoft/act-root/commit/3261f3e50415933456d1f8e3941f5510c8643edd))

# [@rotorsoft/act-tck-v1.27.13](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.12...@rotorsoft/act-tck-v1.27.13) (2026-07-19)


### Bug Fixes

* **act-http:** map a tRPC actor-extractor deny to UNAUTHORIZED, not 500 ([#1286](https://github.com/rotorsoft/act-root/issues/1286)) ([f16c971](https://github.com/rotorsoft/act-root/commit/f16c97182774edc2c64963358f912f4ada411b58))
* **act:** self-re-arm DeferTimer on a premature ceiling clamp ([#1288](https://github.com/rotorsoft/act-root/issues/1288)) ([76cdb0a](https://github.com/rotorsoft/act-root/commit/76cdb0a54a0cba152006d966add715be6179017a))

# [@rotorsoft/act-tck-v1.27.12](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.11...@rotorsoft/act-tck-v1.27.12) (2026-07-18)


### Bug Fixes

* **act-notify:** unsubscribe only the disposing listener on a shared broker ([#1279](https://github.com/rotorsoft/act-root/issues/1279)) ([e1be8ef](https://github.com/rotorsoft/act-root/commit/e1be8efaa557309d42e65cd87c9703b6d16b37ad))

# [@rotorsoft/act-tck-v1.27.11](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.10...@rotorsoft/act-tck-v1.27.11) (2026-07-18)


### Bug Fixes

* **act-http:** map tRPC error codes by identity so wire status matches Hono/OpenAPI ([#1280](https://github.com/rotorsoft/act-root/issues/1280)) ([8cbd4c4](https://github.com/rotorsoft/act-root/commit/8cbd4c4c91b24f625ce7cdcf42c5126653cadc18))
* **act:** advance the watermark past the succeeded prefix on partial-progress defers ([#1278](https://github.com/rotorsoft/act-root/issues/1278)) ([4bfd833](https://github.com/rotorsoft/act-root/commit/4bfd83313f375403031c6781b0f7eb01169f74d7))

# [@rotorsoft/act-tck-v1.27.10](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.9...@rotorsoft/act-tck-v1.27.10) (2026-07-18)


### Bug Fixes

* **act:** drop the pii sidecar inside pii_gate, fixing load's leak and de-duplicating the query gate ([29073b6](https://github.com/rotorsoft/act-root/commit/29073b6bf4766c4b746bdb3adf486c8f52ac1f2e))
* **act:** gate query/query_array with default-deny PII redaction ([#1277](https://github.com/rotorsoft/act-root/issues/1277)) ([a26c5b9](https://github.com/rotorsoft/act-root/commit/a26c5b9661d9f254ce3efac7599a3af33ff6cfa2))

# [@rotorsoft/act-tck-v1.27.9](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.8...@rotorsoft/act-tck-v1.27.9) (2026-07-18)


### Bug Fixes

* **act:** validate BackoffOptions at declaration so a bad config throws at build ([#1269](https://github.com/rotorsoft/act-root/issues/1269)) ([e181e78](https://github.com/rotorsoft/act-root/commit/e181e78d4bab10f14b335510da3f56cb656a7cdb))

# [@rotorsoft/act-tck-v1.27.8](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.7...@rotorsoft/act-tck-v1.27.8) (2026-07-17)


### Bug Fixes

* **act:** move snapshot-floor eligibility to the orchestrator; delete per-adapter guards ([69c3f09](https://github.com/rotorsoft/act-root/commit/69c3f09a384054f03c4dc1e77dd83fe831f46eb7)), closes [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1267](https://github.com/rotorsoft/act-root/issues/1267) [#1270](https://github.com/rotorsoft/act-root/issues/1270) [#1274](https://github.com/rotorsoft/act-root/issues/1274) [#1267](https://github.com/rotorsoft/act-root/issues/1267) [#1270](https://github.com/rotorsoft/act-root/issues/1270) [#1274](https://github.com/rotorsoft/act-root/issues/1274)

# [@rotorsoft/act-tck-v1.27.7](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.6...@rotorsoft/act-tck-v1.27.7) (2026-07-17)


### Bug Fixes

* **act-ops:** move idempotency keys to tail on touch so commit can't corrupt gc/eviction ([#1268](https://github.com/rotorsoft/act-root/issues/1268)) ([5c08f11](https://github.com/rotorsoft/act-root/commit/5c08f11b6583292c70b4239a2d55e2541d3bffa9))
* **act:** persist backoff windows to deferred_at, ending the phantom-retry bug ([ecca43e](https://github.com/rotorsoft/act-root/commit/ecca43e04a77311ab0f81e03e3b9feba1197bced)), closes [#1262](https://github.com/rotorsoft/act-root/issues/1262)

# [@rotorsoft/act-tck-v1.27.6](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.5...@rotorsoft/act-tck-v1.27.6) (2026-07-16)


### Bug Fixes

* **act:** suppress snapshot resume-floor under time bounds; guard InMemory re-block ([b0b3ea0](https://github.com/rotorsoft/act-root/commit/b0b3ea0861ac27a28373dff5b545b9b4bbd7b8f9)), closes [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1263](https://github.com/rotorsoft/act-root/issues/1263) [#1261](https://github.com/rotorsoft/act-root/issues/1261) [#1263](https://github.com/rotorsoft/act-root/issues/1263)

# [@rotorsoft/act-tck-v1.27.5](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.4...@rotorsoft/act-tck-v1.27.5) (2026-07-16)


### Bug Fixes

* **act:** align InMemoryStore restore + created filters with durable adapters ([acd797e](https://github.com/rotorsoft/act-root/commit/acd797e6efa3acaf2990da5281c228c6792e7a89)), closes [#1257](https://github.com/rotorsoft/act-root/issues/1257) [#1258](https://github.com/rotorsoft/act-root/issues/1258) [#1257](https://github.com/rotorsoft/act-root/issues/1257) [#1258](https://github.com/rotorsoft/act-root/issues/1258)

# [@rotorsoft/act-tck-v1.27.4](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.3...@rotorsoft/act-tck-v1.27.4) (2026-07-15)


### Bug Fixes

* **act:** carry the winning reaction's lane in dynamic-resolver correlation ([86ff024](https://github.com/rotorsoft/act-root/commit/86ff024e0a34d3a9fbb5c7ea2ae63bf9ba9605c3)), closes [#1255](https://github.com/rotorsoft/act-root/issues/1255)
* **act:** serialize windowed closes so the archive fires at most once per pruned range ([15edb86](https://github.com/rotorsoft/act-root/commit/15edb86893b32b3c0db8913d2df6d9cd2755a748)), closes [#1222](https://github.com/rotorsoft/act-root/issues/1222)

# [@rotorsoft/act-tck-v1.27.3](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.2...@rotorsoft/act-tck-v1.27.3) (2026-07-15)


### Bug Fixes

* **act:** reserve a fairness slot in the lagging frontier ([ff4b47a](https://github.com/rotorsoft/act-root/commit/ff4b47ade333215d4758ab6dd588d95229868bf1)), closes [hi#priority](https://github.com/hi/issues/priority) [#1223](https://github.com/rotorsoft/act-root/issues/1223)

# [@rotorsoft/act-tck-v1.27.2](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.1...@rotorsoft/act-tck-v1.27.2) (2026-07-12)


### Bug Fixes

* **act-pg:** lock only claimed candidates in claim(), not the whole frontier ([4255ccf](https://github.com/rotorsoft/act-root/commit/4255ccf1f2194f1120beaf2f24c94514867fb5dc))

# [@rotorsoft/act-tck-v1.27.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.27.0...@rotorsoft/act-tck-v1.27.1) (2026-07-12)


### Bug Fixes

* **act-http:** bound sse pending buffer and pair slot release with acquire ([29ad7bd](https://github.com/rotorsoft/act-root/commit/29ad7bddd907ddc007638b6d1b59fee500aed600)), closes [#1196](https://github.com/rotorsoft/act-root/issues/1196)

# [@rotorsoft/act-tck-v1.27.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.10...@rotorsoft/act-tck-v1.27.0) (2026-07-11)


### Features

* **act:** validateFoldedState — opt-in state-schema validation after each reduction ([4b176d6](https://github.com/rotorsoft/act-root/commit/4b176d6fdbbe71dbd64b84fa81dbf360bba504c2)), closes [#1230](https://github.com/rotorsoft/act-root/issues/1230) [#1238](https://github.com/rotorsoft/act-root/issues/1238)

# [@rotorsoft/act-tck-v1.26.10](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-tck-v1.26.9...@rotorsoft/act-tck-v1.26.10) (2026-07-11)

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
