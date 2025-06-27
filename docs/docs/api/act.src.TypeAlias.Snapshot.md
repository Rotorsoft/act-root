[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Snapshot

# Type Alias: Snapshot\<S, E\>

> **Snapshot**\<`S`, `E`\> = `object`

Defined in: [libs/act/src/types/action.ts:36](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L36)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

## Properties

### state

> `readonly` **state**: `S`

Defined in: [libs/act/src/types/action.ts:37](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L37)

***

### event?

> `readonly` `optional` **event**: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>

Defined in: [libs/act/src/types/action.ts:38](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L38)

***

### patches

> `readonly` **patches**: `number`

Defined in: [libs/act/src/types/action.ts:39](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L39)

***

### snaps

> `readonly` **snaps**: `number`

Defined in: [libs/act/src/types/action.ts:40](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L40)
