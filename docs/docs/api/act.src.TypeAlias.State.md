[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / State

# Type Alias: State\<S, E, A\>

> **State**\<`S`, `E`, `A`\> = [`StateSchemas`](act.src.TypeAlias.StateSchemas.md)\<`S`, `E`, `A`\> & `object`

Defined in: [libs/act/src/types/action.ts:95](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L95)

## Type declaration

### name

> **name**: `string`

### init()

> **init**: () => `Readonly`\<`S`\>

#### Returns

`Readonly`\<`S`\>

### patch

> **patch**: [`PatchHandlers`](act.src.TypeAlias.PatchHandlers.md)\<`S`, `E`\>

### on

> **on**: [`ActionHandlers`](act.src.TypeAlias.ActionHandlers.md)\<`S`, `E`, `A`\>

### given?

> `optional` **given**: [`GivenHandlers`](act.src.TypeAlias.GivenHandlers.md)\<`S`, `A`\>

### snap()?

> `optional` **snap**: (`snapshot`) => `boolean`

#### Parameters

##### snapshot

[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`S`, `E`\>

#### Returns

`boolean`

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)
