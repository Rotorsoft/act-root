[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / patch

# Function: patch()

> **patch**\<`S`\>(`original`, `patches`): `Readonly`\<`S`\>

Defined in: [libs/act/src/utils.ts:45](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/utils.ts#L45)

Copies state with patches recursively.
Keys with `undefined` or `null` values in patch are deleted.

## Type Parameters

### S

`S` *extends* [`Schema`](../type-aliases/Schema.md)

## Parameters

### original

`Readonly`\<`S`\>

original state

### patches

`Readonly`\<[`Patch`](../type-aliases/Patch.md)\<`S`\>\>

patches to merge

## Returns

`Readonly`\<`S`\>

a new patched state
