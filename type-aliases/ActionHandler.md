[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActionHandler

# Type Alias: ActionHandler()\<S, E, A, K\>

> **ActionHandler**\<`S`, `E`, `A`, `K`\> = (`action`, `state`, `target`) => [`Emitted`](Emitted.md)\<`E`\> \| [`Emitted`](Emitted.md)\<`E`\>[] \| `undefined`

Defined in: [libs/act/src/types/action.ts:72](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/action.ts#L72)

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
