[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Patch

# Type Alias: Patch\<T\>

> **Patch**\<`T`\> = `{ [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K] }`

Defined in: [libs/act/src/types/action.ts:21](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L21)

## Type Parameters

### T

`T`
