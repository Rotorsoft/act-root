[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActionHandler

# Type Alias: ActionHandler()\<S, E, A, K\>

> **ActionHandler**\<`S`, `E`, `A`, `K`\> = (`action`, `state`, `target`) => [`Emitted`](Emitted.md)\<`E`\> \| [`Emitted`](Emitted.md)\<`E`\>[] \| `undefined`

Defined in: [libs/act/src/types/action.ts:72](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L72)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)

### K

`K` *extends* keyof `A`

## Parameters

### action

`Readonly`\<`A`\[`K`\]\>

### state

`Readonly`\<`S`\>

### target

[`Target`](Target.md)

## Returns

[`Emitted`](Emitted.md)\<`E`\> \| [`Emitted`](Emitted.md)\<`E`\>[] \| `undefined`
