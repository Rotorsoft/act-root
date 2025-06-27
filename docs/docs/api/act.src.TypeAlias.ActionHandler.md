[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ActionHandler

# Type Alias: ActionHandler()\<S, E, A, K\>

> **ActionHandler**\<`S`, `E`, `A`, `K`\> = (`action`, `state`, `target`) => [`Emitted`](act.src.TypeAlias.Emitted.md)\<`E`\> \| [`Emitted`](act.src.TypeAlias.Emitted.md)\<`E`\>[] \| `undefined`

Defined in: [libs/act/src/types/action.ts:72](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L72)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### K

`K` *extends* keyof `A`

## Parameters

### action

`Readonly`\<`A`\[`K`\]\>

### state

`Readonly`\<`S`\>

### target

[`Target`](act.src.TypeAlias.Target.md)

## Returns

[`Emitted`](act.src.TypeAlias.Emitted.md)\<`E`\> \| [`Emitted`](act.src.TypeAlias.Emitted.md)\<`E`\>[] \| `undefined`
