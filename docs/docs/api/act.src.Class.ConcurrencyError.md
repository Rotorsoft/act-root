[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ConcurrencyError

# Class: ConcurrencyError

Defined in: [libs/act/src/types/errors.ts:40](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L40)

## Extends

- `Error`

## Constructors

### Constructor

> **new ConcurrencyError**(`lastVersion`, `events`, `expectedVersion`): `ConcurrencyError`

Defined in: [libs/act/src/types/errors.ts:41](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L41)

#### Parameters

##### lastVersion

`number`

##### events

[`Message`](act.src.TypeAlias.Message.md)\<[`Schemas`](act.src.TypeAlias.Schemas.md), `string`\>[]

##### expectedVersion

`number`

#### Returns

`ConcurrencyError`

#### Overrides

`Error.constructor`

## Properties

### lastVersion

> `readonly` **lastVersion**: `number`

Defined in: [libs/act/src/types/errors.ts:42](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L42)

***

### events

> `readonly` **events**: [`Message`](act.src.TypeAlias.Message.md)\<[`Schemas`](act.src.TypeAlias.Schemas.md), `string`\>[]

Defined in: [libs/act/src/types/errors.ts:43](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L43)

***

### expectedVersion

> `readonly` **expectedVersion**: `number`

Defined in: [libs/act/src/types/errors.ts:44](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L44)
