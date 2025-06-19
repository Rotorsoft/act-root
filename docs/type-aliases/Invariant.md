[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Invariant

# Type Alias: Invariant\<S\>

> **Invariant**\<`S`\> = `object`

Defined in: [libs/act/src/types/action.ts:43](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L43)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

## Properties

### description

> **description**: `string`

Defined in: [libs/act/src/types/action.ts:44](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L44)

***

### valid()

> **valid**: (`state`, `actor?`) => `boolean`

Defined in: [libs/act/src/types/action.ts:45](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L45)

#### Parameters

##### state

`Readonly`\<`S`\>

##### actor?

[`Actor`](Actor.md)

#### Returns

`boolean`
