[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Invariant

# Type Alias: Invariant\<S\>

> **Invariant**\<`S`\> = `object`

Defined in: [libs/act/src/types/action.ts:43](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L43)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

## Properties

### description

> **description**: `string`

Defined in: [libs/act/src/types/action.ts:44](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L44)

***

### valid()

> **valid**: (`state`, `actor?`) => `boolean`

Defined in: [libs/act/src/types/action.ts:45](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L45)

#### Parameters

##### state

`Readonly`\<`S`\>

##### actor?

[`Actor`](Actor.md)

#### Returns

`boolean`
