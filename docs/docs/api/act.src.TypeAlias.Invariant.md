[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Invariant

# Type Alias: Invariant\<S\>

> **Invariant**\<`S`\> = `object`

Defined in: [libs/act/src/types/action.ts:43](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L43)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

## Properties

### description

> **description**: `string`

Defined in: [libs/act/src/types/action.ts:44](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L44)

***

### valid()

> **valid**: (`state`, `actor?`) => `boolean`

Defined in: [libs/act/src/types/action.ts:45](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L45)

#### Parameters

##### state

`Readonly`\<`S`\>

##### actor?

[`Actor`](act.src.TypeAlias.Actor.md)

#### Returns

`boolean`
