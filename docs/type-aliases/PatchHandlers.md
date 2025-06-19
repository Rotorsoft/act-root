[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / PatchHandlers

# Type Alias: PatchHandlers\<S, E\>

> **PatchHandlers**\<`S`, `E`\> = `{ [K in keyof E]: PatchHandler<S, E, K> }`

Defined in: [libs/act/src/types/action.ts:68](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L68)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)
