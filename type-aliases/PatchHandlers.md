[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / PatchHandlers

# Type Alias: PatchHandlers\<S, E\>

> **PatchHandlers**\<`S`, `E`\> = `{ [K in keyof E]: PatchHandler<S, E, K> }`

Defined in: [libs/act/src/types/action.ts:68](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L68)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)
