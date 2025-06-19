[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / InvariantError

# Class: InvariantError

Defined in: [libs/act/src/types/errors.ts:26](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/errors.ts#L26)

## Extends

- `Error`

## Constructors

### Constructor

> **new InvariantError**(`name`, `payload`, `target`, `description`): `InvariantError`

Defined in: [libs/act/src/types/errors.ts:28](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/errors.ts#L28)

#### Parameters

##### name

`string`

##### payload

[`Schema`](../type-aliases/Schema.md)

##### target

[`Target`](../type-aliases/Target.md)

##### description

`string`

#### Returns

`InvariantError`

#### Overrides

`Error.constructor`

## Properties

### details

> `readonly` **details**: `object`

Defined in: [libs/act/src/types/errors.ts:27](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/errors.ts#L27)

#### name

> **name**: `string`

#### payload

> **payload**: [`Schema`](../type-aliases/Schema.md)

#### target

> **target**: `Readonly`\<\{ `stream`: `string`; `actor`: `Readonly`\<\{ `id`: `string`; `name`: `string`; \}\>; `expectedVersion?`: `number`; \}\>

#### description

> **description**: `string`
