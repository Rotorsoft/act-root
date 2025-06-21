[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ZodTypes

# Type Alias: ZodTypes\<T\>

> **ZodTypes**\<`T`\> = `{ [K in keyof T]: ZodType<T[K]> }`

Defined in: [libs/act/src/types/action.ts:24](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L24)

## Type Parameters

### T

`T` *extends* [`Schemas`](Schemas.md)
