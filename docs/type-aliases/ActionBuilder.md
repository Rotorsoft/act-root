[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / ActionBuilder

# Type Alias: ActionBuilder\<S, E, A\>

> **ActionBuilder**\<`S`, `E`, `A`\> = `object`

Defined in: [libs/act/src/state-builder.ts:26](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/state-builder.ts#L26)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

### E

`E` *extends* [`Schemas`](Schemas.md)

### A

`A` *extends* [`Schemas`](Schemas.md)

## Properties

### on()

> **on**: \<`K`, `AX`\>(`action`, `schema`) => `object`

Defined in: [libs/act/src/state-builder.ts:31](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/state-builder.ts#L31)

#### Type Parameters

##### K

`K` *extends* `string`

##### AX

`AX` *extends* [`Schema`](Schema.md)

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

[`Invariant`](Invariant.md)\<`S`\>[]

###### Returns

`object`

###### emit()

> **emit**: (`handler`) => `ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

###### Parameters

###### handler

[`ActionHandler`](ActionHandler.md)\<`S`, `E`, `{ [P in K]: AX }`, `K`\>

###### Returns

`ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

##### emit()

> **emit**: (`handler`) => `ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

###### Parameters

###### handler

[`ActionHandler`](ActionHandler.md)\<`S`, `E`, `{ [P in K]: AX }`, `K`\>

###### Returns

`ActionBuilder`\<`S`, `E`, `A` & `{ [P in K]: AX }`\>

***

### snap()

> **snap**: (`snap`) => `ActionBuilder`\<`S`, `E`, `A`\>

Defined in: [libs/act/src/state-builder.ts:44](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/state-builder.ts#L44)

#### Parameters

##### snap

(`snapshot`) => `boolean`

#### Returns

`ActionBuilder`\<`S`, `E`, `A`\>

***

### build()

> **build**: () => [`State`](State.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/state-builder.ts:45](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/state-builder.ts#L45)

#### Returns

[`State`](State.md)\<`S`, `E`, `A`\>
