[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActionHandlers

# Type Alias: ActionHandlers\<S, E, A\>

> **ActionHandlers**\<`S`, `E`, `A`\> = `{ [K in keyof A]: ActionHandler<S, E, A, K> }`

Defined in: [libs/act/src/types/action.ts:83](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L83)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)
