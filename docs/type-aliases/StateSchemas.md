[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / StateSchemas

# Type Alias: StateSchemas\<S, E, A\>

> **StateSchemas**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/types/action.ts:52](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L52)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)

## Properties

### events

> `readonly` **events**: [`ZodTypes`](ZodTypes.md)\<`E`\>

Defined in: [libs/act/src/types/action.ts:57](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L57)

***

### actions

> `readonly` **actions**: [`ZodTypes`](ZodTypes.md)\<`A`\>

Defined in: [libs/act/src/types/action.ts:58](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L58)

***

### state

> `readonly` **state**: `ZodType`\<`S`\>

Defined in: [libs/act/src/types/action.ts:59](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L59)
