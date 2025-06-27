[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / PatchHandler

# Type Alias: PatchHandler()\<S, E, K\>

> **PatchHandler**\<`S`, `E`, `K`\> = (`event`, `state`) => `Readonly`\<[`Patch`](act.src.TypeAlias.Patch.md)\<`S`\>\>

Defined in: [libs/act/src/types/action.ts:62](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L62)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### K

`K` *extends* keyof `E`

## Parameters

### event

[`Committed`](act.src.TypeAlias.Committed.md)\<`E`, `K`\>

### state

`Readonly`\<`S`\>

## Returns

`Readonly`\<[`Patch`](act.src.TypeAlias.Patch.md)\<`S`\>\>
