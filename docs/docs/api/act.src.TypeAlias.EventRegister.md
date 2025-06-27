[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / EventRegister

# Type Alias: EventRegister\<E\>

> **EventRegister**\<`E`\> = `{ [K in keyof E]: { schema: ZodType<E[K]>; reactions: Map<string, Reaction<E, K>> } }`

Defined in: [libs/act/src/types/registry.ts:5](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/registry.ts#L5)

## Type Parameters

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)
