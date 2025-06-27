[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Emitted

# Type Alias: Emitted\<E\>

> **Emitted**\<`E`\> = `{ [K in keyof E]: readonly [K, Readonly<E[K]>] }`\[keyof `E`\]

Defined in: [libs/act/src/types/action.ts:48](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L48)

## Type Parameters

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)
