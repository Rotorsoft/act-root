[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / ActionBuilder

# Type Alias: ActionBuilder\<S, E, A\>

> **ActionBuilder**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/state-builder.ts:26](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L26)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

## Properties

### on()

> **on**: \<`K`, `AX`\>(`action`, `schema`) => `object`

Defined in: [libs/act/src/state-builder.ts:31](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L31)

#### Type Parameters

##### K

`K` *extends* `string`

##### AX

`AX` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

#### Parameters

##### action

`K`

##### schema

`ZodType`\<`AX`\>

#### Returns

`object`

##### given()

> **given**: (`rules`) => `object`

###### Parameters

###### rules

[`Invariant`](act.src.TypeAlias.Invariant.md)\<`S`\>[]

###### Returns

`object`

###### emit()

> **emit**: (`handler`) => `ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

###### Parameters

###### handler

[`ActionHandler`](act.src.TypeAlias.ActionHandler.md)\<`S`, `E`, `{ [P in K]: AX }`, `K`\>

###### Returns

`ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

##### emit()

> **emit**: (`handler`) => `ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

###### Parameters

###### handler

[`ActionHandler`](act.src.TypeAlias.ActionHandler.md)\<`S`, `E`, `{ [P in K]: AX }`, `K`\>

###### Returns

`ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

***

### snap()

> **snap**: (`snap`) => `ActionBuilder`\<`S`, `E`, `A`\>

Defined in: [libs/act/src/state-builder.ts:44](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L44)

#### Parameters

##### snap

(`snapshot`) => `boolean`

#### Returns

`ActionBuilder`\<`S`, `E`, `A`\>

***

### build()

> **build**: () => [`State`](act.src.TypeAlias.State.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/state-builder.ts:45](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L45)

#### Returns

[`State`](act.src.TypeAlias.State.md)\<`S`, `E`, `A`\>
