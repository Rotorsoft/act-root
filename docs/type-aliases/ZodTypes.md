[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ZodTypes

# Type Alias: ZodTypes\<T\>

> **ZodTypes**\<`T`\> = `{ [K in keyof T]: ZodType<T[K]> }`

Defined in: [libs/act/src/types/action.ts:24](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L24)

## Type Parameters

### T

`T` *extends* [`Schemas`](Schemas.md)
