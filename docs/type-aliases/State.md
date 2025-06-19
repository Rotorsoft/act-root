[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / State

# Type Alias: State\<S, E, A\>

> **State**\<`S`, `E`, `A`\> = [`StateSchemas`](StateSchemas.md)\<`S`, `E`, `A`\> & `object`

Defined in: [libs/act/src/types/action.ts:95](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L95)

## Type declaration

### name

> **name**: `string`

### init()

> **init**: () => `Readonly`\<`S`\>

#### Returns

`Readonly`\<`S`\>

### patch

> **patch**: [`PatchHandlers`](PatchHandlers.md)\<`S`, `E`\>

### on

> **on**: [`ActionHandlers`](ActionHandlers.md)\<`S`, `E`, `A`\>

### given?

> `optional` **given**: [`GivenHandlers`](GivenHandlers.md)\<`S`, `A`\>

### snap()?

> `optional` **snap**: (`snapshot`) => `boolean`

#### Parameters

##### snapshot

[`Snapshot`](Snapshot.md)\<`S`, `E`\>

#### Returns

`boolean`

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)
