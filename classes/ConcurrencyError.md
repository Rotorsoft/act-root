[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ConcurrencyError

# Class: ConcurrencyError

Defined in: [libs/act/src/types/errors.ts:40](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/errors.ts#L40)

## Extends

- `Error`

## Constructors

### Constructor

> **new ConcurrencyError**(`lastVersion`, `events`, `expectedVersion`): `ConcurrencyError`

Defined in: [libs/act/src/types/errors.ts:41](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/errors.ts#L41)

#### Parameters

##### lastVersion

`number`

##### events

[`Message`](../type-aliases/Message.md)\<[`Schemas`](../type-aliases/Schemas.md), `string`\>[]

##### expectedVersion

`number`

#### Returns

`ConcurrencyError`

#### Overrides

`Error.constructor`

## Properties

### lastVersion

> `readonly` **lastVersion**: `number`

Defined in: [libs/act/src/types/errors.ts:42](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/errors.ts#L42)

***

### events

> `readonly` **events**: [`Message`](../type-aliases/Message.md)\<[`Schemas`](../type-aliases/Schemas.md), `string`\>[]

Defined in: [libs/act/src/types/errors.ts:43](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/errors.ts#L43)

***

### expectedVersion

> `readonly` **expectedVersion**: `number`

Defined in: [libs/act/src/types/errors.ts:44](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/errors.ts#L44)
