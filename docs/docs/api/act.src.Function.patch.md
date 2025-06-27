[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / patch

# Function: patch()

> **patch**\<`S`\>(`original`, `patches`): `Readonly`\<`S`\>

Defined in: [libs/act/src/utils.ts:45](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/utils.ts#L45)

Copies state with patches recursively.
Keys with `undefined` or `null` values in patch are deleted.

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

## Parameters

### original

`Readonly`\<`S`\>

original state

### patches

`Readonly`\<[`Patch`](act.src.TypeAlias.Patch.md)\<`S`\>\>

patches to merge

## Returns

`Readonly`\<`S`\>

a new patched state
