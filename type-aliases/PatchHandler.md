[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / PatchHandler

# Type Alias: PatchHandler()\<S, E, K\>

> **PatchHandler**\<`S`, `E`, `K`\> = (`event`, `state`) => `Readonly`\<[`Patch`](Patch.md)\<`S`\>\>

Defined in: [libs/act/src/types/action.ts:62](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L62)

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
