[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ActionHandlers

# Type Alias: ActionHandlers\<S, E, A\>

> **ActionHandlers**\<`S`, `E`, `A`\> = `{ [K in keyof A]: ActionHandler<S, E, A, K> }`

Defined in: [libs/act/src/types/action.ts:83](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L83)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)
