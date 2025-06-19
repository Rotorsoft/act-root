[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Message

# Type Alias: Message\<E, K\>

> **Message**\<`E`, `K`\> = `object`

Defined in: [libs/act/src/types/action.ts:28](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L28)

## Type Parameters

### E

`E` *extends* [`Schemas`](Schemas.md)

### K

`K` *extends* keyof `E`

## Properties

### name

> `readonly` **name**: `K`

Defined in: [libs/act/src/types/action.ts:29](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L29)

***

### data

> `readonly` **data**: `Readonly`\<`E`\[`K`\]\>

Defined in: [libs/act/src/types/action.ts:30](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/action.ts#L30)
