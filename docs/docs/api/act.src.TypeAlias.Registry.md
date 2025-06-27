[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Registry

# Type Alias: Registry\<S, E, A\>

> **Registry**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/types/registry.ts:14](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/registry.ts#L14)

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](act.src.TypeAlias.SchemaRegister.md)\<`A`\>

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

## Properties

### actions

> `readonly` **actions**: `{ [K in keyof A]: State<S[K], E, A> }`

Defined in: [libs/act/src/types/registry.ts:19](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/registry.ts#L19)

***

### events

> `readonly` **events**: [`EventRegister`](act.src.TypeAlias.EventRegister.md)\<`E`\>

Defined in: [libs/act/src/types/registry.ts:20](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/registry.ts#L20)
