---
id: rules
title: Rules across streams
---

# Rules across streams

Every rule that spans streams, each as a small state: unique values, count limits, another state's schema, several streams at once, and reads. One action loads the states its decision needs and commits its events to all of them at once, or to none.

**Source:** [packages/rules/src/](https://github.com/rotorsoft/act-root/tree/master/packages/rules/src)

**See it animated:** [Rules across streams](pathname:///flows/rules-across-streams.html) plays a commit across streams, a lost race, a read and a release.

## The patterns

| Pattern | What's in the package |
|---|---|
| A unique value is a state of its own | User email, vehicle plate, a token, one review per product |
| A limit is a state with a count | Course capacity, a student's maximum courses, sessions per user, gapless invoice numbers |
| Another state's schema holds the rule | Room booking, invoice payments, inventory, bike rental |
| Several streams, all or none | Money transfer, library loans |
| A read isn't guarded | The displayed price |

## Run it

```bash
pnpm dev:rules
```

The tour runs one action at a time, and prints what landed or the refusal a client would get. [`.loads`](../concepts/state-management.md#rules-across-streams-loads) explains the mechanism, and the package's [README](https://github.com/rotorsoft/act-root/tree/master/packages/rules) says where each rule goes and why.
