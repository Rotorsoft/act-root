[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Emitted

# Type Alias: Emitted\<E\>

> **Emitted**\<`E`\> = `{ [K in keyof E]: readonly [K, Readonly<E[K]>] }`\[keyof `E`\]

Defined in: [libs/act/src/types/action.ts:48](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L48)

## Type Parameters

### E

`E` *extends* [`Schemas`](Schemas.md)
