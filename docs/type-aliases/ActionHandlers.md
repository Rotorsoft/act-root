[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActionHandlers

# Type Alias: ActionHandlers\<S, E, A\>

> **ActionHandlers**\<`S`, `E`, `A`\> = `{ [K in keyof A]: ActionHandler<S, E, A, K> }`

Defined in: [libs/act/src/types/action.ts:83](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/action.ts#L83)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)
