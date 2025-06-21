[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Registry

# Type Alias: Registry\<S, E, A\>

> **Registry**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/types/registry.ts:14](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/registry.ts#L14)

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](SchemaRegister.md)\<`A`\>

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)

## Properties

### actions

> `readonly` **actions**: `{ [K in keyof A]: State<S[K], E, A> }`

Defined in: [libs/act/src/types/registry.ts:19](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/registry.ts#L19)

***

### events

> `readonly` **events**: [`EventRegister`](EventRegister.md)\<`E`\>

Defined in: [libs/act/src/types/registry.ts:20](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/registry.ts#L20)
