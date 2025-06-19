[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Emitted

# Type Alias: Emitted\<E\>

> **Emitted**\<`E`\> = `{ [K in keyof E]: readonly [K, Readonly<E[K]>] }`\[keyof `E`\]

Defined in: [libs/act/src/types/action.ts:48](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L48)

## Type Parameters

### E

`E` *extends* [`Schemas`](Schemas.md)
