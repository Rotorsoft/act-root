[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / PatchHandler

# Type Alias: PatchHandler()\<S, E, K\>

> **PatchHandler**\<`S`, `E`, `K`\> = (`event`, `state`) => `Readonly`\<[`Patch`](Patch.md)\<`S`\>\>

Defined in: [libs/act/src/types/action.ts:62](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L62)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### K

`K` *extends* keyof `E`

## Parameters

### event

[`Committed`](Committed.md)\<`E`, `K`\>

### state

`Readonly`\<`S`\>

## Returns

`Readonly`\<[`Patch`](Patch.md)\<`S`\>\>
