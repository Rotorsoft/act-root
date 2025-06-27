[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / InvariantError

# Class: InvariantError

Defined in: [libs/act/src/types/errors.ts:26](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L26)

## Extends

- `Error`

## Constructors

### Constructor

> **new InvariantError**(`name`, `payload`, `target`, `description`): `InvariantError`

Defined in: [libs/act/src/types/errors.ts:28](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L28)

#### Parameters

##### name

`string`

##### payload

[`Schema`](act.src.TypeAlias.Schema.md)

##### target

[`Target`](act.src.TypeAlias.Target.md)

##### description

`string`

#### Returns

`InvariantError`

#### Overrides

`Error.constructor`

## Properties

### details

> `readonly` **details**: `object`

Defined in: [libs/act/src/types/errors.ts:27](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L27)

#### name

> **name**: `string`

#### payload

> **payload**: [`Schema`](act.src.TypeAlias.Schema.md)

#### target

> **target**: `Readonly`\<\{ `stream`: `string`; `actor`: `Readonly`\<\{ `id`: `string`; `name`: `string`; \}\>; `expectedVersion?`: `number`; \}\>

#### description

> **description**: `string`
