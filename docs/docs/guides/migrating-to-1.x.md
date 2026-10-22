---
id: migrating-to-1.x
title: Migrating to 1.x
sidebar_position: 20
---

# Migrating to 1.x

There is nothing to migrate within the `1.x` line. Pull the newest release and run your tests:

```bash
pnpm up "@rotorsoft/act@^1" "@rotorsoft/act-pg@^1" "@rotorsoft/act-sqlite@^1"
```

What each release may change, the support window, and the deprecation policy are in the [Stability Charter](https://github.com/Rotorsoft/act-root/blob/master/STABILITY.md).

`@rotorsoft/act-sse` has been removed from this repo. Versions already on npm keep working; to move off it, import from `@rotorsoft/act-http/sse` instead.
