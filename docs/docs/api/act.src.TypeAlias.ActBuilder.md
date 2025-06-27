[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ActBuilder

# Type Alias: ActBuilder\<S, E, A\>

> **ActBuilder**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/act-builder.ts:28](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L28)

Fluent builder for composing event-sourced state machines with actions and reactions.
Provides a chainable API for registering states, events, and reaction handlers.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](act.src.TypeAlias.SchemaRegister.md)\<`A`\>

SchemaRegister for state

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

Schemas for events

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

Schemas for actions

## Properties

### with()

> **with**: \<`SX`, `EX`, `AX`\>(`state`) => `ActBuilder`\<`S` & `{ [K in keyof AX]: SX }`, `E` & `EX`, `A` & `AX`\>

Defined in: [libs/act/src/act-builder.ts:33](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L33)

#### Type Parameters

##### SX

`SX` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

##### EX

`EX` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

##### AX

`AX` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

#### Parameters

##### state

[`State`](act.src.TypeAlias.State.md)\<`SX`, `EX`, `AX`\>

#### Returns

`ActBuilder`\<`S` & `{ [K in keyof AX]: SX }`, `E` & `EX`, `A` & `AX`\>

***

### on()

> **on**: \<`K`\>(`event`) => `object`

Defined in: [libs/act/src/act-builder.ts:36](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L36)

#### Type Parameters

##### K

`K` *extends* keyof `E`

#### Parameters

##### event

`K`

#### Returns

`object`

##### do()

> **do**: (`handler`, `options?`) => `ActBuilder`\<`S`, `E`, `A`\> & `object`

###### Parameters

###### handler

[`ReactionHandler`](act.src.TypeAlias.ReactionHandler.md)\<`E`, `K`\>

###### options?

`Partial`\<[`ReactionOptions`](act.src.TypeAlias.ReactionOptions.md)\>

###### Returns

`ActBuilder`\<`S`, `E`, `A`\> & `object`

***

### build()

> **build**: (`drainLimit?`) => [`Act`](act.src.Class.Act.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act-builder.ts:47](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L47)

#### Parameters

##### drainLimit?

`number`

#### Returns

[`Act`](act.src.Class.Act.md)\<`S`, `E`, `A`\>

***

### events

> `readonly` **events**: [`EventRegister`](act.src.TypeAlias.EventRegister.md)\<`E`\>

Defined in: [libs/act/src/act-builder.ts:48](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L48)
