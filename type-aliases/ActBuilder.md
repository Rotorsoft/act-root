[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActBuilder

# Type Alias: ActBuilder\<S, E, A\>

> **ActBuilder**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/act-builder.ts:28](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/act-builder.ts#L28)

Fluent builder for composing event-sourced state machines with actions and reactions.
Provides a chainable API for registering states, events, and reaction handlers.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](SchemaRegister.md)\<`A`\>

SchemaRegister for state

### E

`E` *extends* [`Schemas`](Schemas.md)

Schemas for events

### A

`A` *extends* [`Schemas`](Schemas.md)

Schemas for actions

## Properties

### with()

> **with**: \<`SX`, `EX`, `AX`\>(`state`) => `ActBuilder`\<`S` & `{ [K in keyof AX]: SX }`, `E` & `EX`, `A` & `AX`\>

Defined in: [libs/act/src/act-builder.ts:33](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/act-builder.ts#L33)

#### Type Parameters

##### SX

`SX` *extends* [`Schema`](Schema.md)

##### EX

`EX` *extends* [`Schemas`](Schemas.md)

##### AX

`AX` *extends* [`Schemas`](Schemas.md)

#### Parameters

##### state

[`State`](State.md)\<`SX`, `EX`, `AX`\>

#### Returns

`ActBuilder`\<`S` & `{ [K in keyof AX]: SX }`, `E` & `EX`, `A` & `AX`\>

***

### on()

> **on**: \<`K`\>(`event`) => `object`

Defined in: [libs/act/src/act-builder.ts:36](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/act-builder.ts#L36)

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

[`ReactionHandler`](ReactionHandler.md)\<`E`, `K`\>

###### options?

`Partial`\<[`ReactionOptions`](ReactionOptions.md)\>

###### Returns

`ActBuilder`\<`S`, `E`, `A`\> & `object`

***

### build()

> **build**: (`drainLimit?`) => [`Act`](../classes/Act.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act-builder.ts:47](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/act-builder.ts#L47)

#### Parameters

##### drainLimit?

`number`

#### Returns

[`Act`](../classes/Act.md)\<`S`, `E`, `A`\>

***

### events

> `readonly` **events**: [`EventRegister`](EventRegister.md)\<`E`\>

Defined in: [libs/act/src/act-builder.ts:48](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/act-builder.ts#L48)
