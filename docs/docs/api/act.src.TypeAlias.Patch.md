[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Patch

# Type Alias: Patch\<T\>

> **Patch**\<`T`\> = `{ [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> : T[K] }`

Defined in: [libs/act/src/types/action.ts:21](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L21)

## Type Parameters

### T

`T`
