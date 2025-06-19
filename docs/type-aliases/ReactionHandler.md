[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ReactionHandler

# Type Alias: ReactionHandler()\<E, K\>

> **ReactionHandler**\<`E`, `K`\> = (`event`, `stream`) => `Promise`\<[`Snapshot`](Snapshot.md)\<`E`, [`Schema`](Schema.md)\> \| `void`\>

Defined in: [libs/act/src/types/reaction.ts:3](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/reaction.ts#L3)

## Type Parameters

### E

`E` *extends* [`Schemas`](Schemas.md)

### K

`K` *extends* keyof `E`

## Parameters

### event

[`Committed`](Committed.md)\<`E`, `K`\>

### stream

`string`

## Returns

`Promise`\<[`Snapshot`](Snapshot.md)\<`E`, [`Schema`](Schema.md)\> \| `void`\>
