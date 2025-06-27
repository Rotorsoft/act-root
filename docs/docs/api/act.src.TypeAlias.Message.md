[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Message

# Type Alias: Message\<E, K\>

> **Message**\<`E`, `K`\> = `object`

Defined in: [libs/act/src/types/action.ts:28](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L28)

## Type Parameters

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### K

`K` *extends* keyof `E`

## Properties

### name

> `readonly` **name**: `K`

Defined in: [libs/act/src/types/action.ts:29](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L29)

***

### data

> `readonly` **data**: `Readonly`\<`E`\[`K`\]\>

Defined in: [libs/act/src/types/action.ts:30](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/action.ts#L30)
