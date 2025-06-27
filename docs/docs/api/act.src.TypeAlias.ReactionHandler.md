[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ReactionHandler

# Type Alias: ReactionHandler()\<E, K\>

> **ReactionHandler**\<`E`, `K`\> = (`event`, `stream`) => `Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`E`, [`Schema`](act.src.TypeAlias.Schema.md)\> \| `void`\>

Defined in: [libs/act/src/types/reaction.ts:3](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/reaction.ts#L3)

## Type Parameters

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### K

`K` *extends* keyof `E`

## Parameters

### event

[`Committed`](act.src.TypeAlias.Committed.md)\<`E`, `K`\>

### stream

`string`

## Returns

`Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`E`, [`Schema`](act.src.TypeAlias.Schema.md)\> \| `void`\>
