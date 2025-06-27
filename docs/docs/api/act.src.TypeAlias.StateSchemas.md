[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / StateSchemas

# Type Alias: StateSchemas\<S, E, A\>

> **StateSchemas**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/types/action.ts:52](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L52)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

## Properties

### events

> `readonly` **events**: [`ZodTypes`](act.src.TypeAlias.ZodTypes.md)\<`E`\>

Defined in: [libs/act/src/types/action.ts:57](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L57)

***

### actions

> `readonly` **actions**: [`ZodTypes`](act.src.TypeAlias.ZodTypes.md)\<`A`\>

Defined in: [libs/act/src/types/action.ts:58](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L58)

***

### state

> `readonly` **state**: `ZodType`\<`S`\>

Defined in: [libs/act/src/types/action.ts:59](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L59)
