[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / EventRegister

# Type Alias: EventRegister\<E\>

> **EventRegister**\<`E`\> = `{ [K in keyof E]: { schema: ZodType<E[K]>; reactions: Map<string, Reaction<E, K>> } }`

Defined in: [libs/act/src/types/registry.ts:5](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/registry.ts#L5)

## Type Parameters

### E

`E` *extends* [`Schemas`](Schemas.md)
