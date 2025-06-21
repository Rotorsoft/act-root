[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Snapshot

# Type Alias: Snapshot\<S, E\>

> **Snapshot**\<`S`, `E`\> = `object`

Defined in: [libs/act/src/types/action.ts:36](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L36)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

## Properties

### state

> `readonly` **state**: `S`

Defined in: [libs/act/src/types/action.ts:37](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L37)

***

### event?

> `readonly` `optional` **event**: [`Committed`](Committed.md)\<`E`, keyof `E`\>

Defined in: [libs/act/src/types/action.ts:38](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L38)

***

### patches

> `readonly` **patches**: `number`

Defined in: [libs/act/src/types/action.ts:39](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L39)

***

### snaps

> `readonly` **snaps**: `number`

Defined in: [libs/act/src/types/action.ts:40](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L40)
