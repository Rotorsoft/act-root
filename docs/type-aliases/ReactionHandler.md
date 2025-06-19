[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ReactionHandler

# Type Alias: ReactionHandler()\<E, K\>

> **ReactionHandler**\<`E`, `K`\> = (`event`, `stream`) => `Promise`\<[`Snapshot`](Snapshot.md)\<`E`, [`Schema`](Schema.md)\> \| `void`\>

Defined in: [libs/act/src/types/reaction.ts:3](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/reaction.ts#L3)

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
