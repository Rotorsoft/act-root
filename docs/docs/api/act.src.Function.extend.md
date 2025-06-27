[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / extend

# Function: extend()

> **extend**\<`S`, `T`\>(`source`, `schema`, `target?`): `Readonly`\<`S` & `T`\>

Defined in: [libs/act/src/utils.ts:88](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/utils.ts#L88)

Extends target payload with source payload after validating source

## Type Parameters

### S

`S` *extends* `Record`\<`string`, `unknown`\>

### T

`T` *extends* `Record`\<`string`, `unknown`\>

## Parameters

### source

`Readonly`\<`S`\>

### schema

`ZodType`\<`S`\>

### target?

`Readonly`\<`T`\>

## Returns

`Readonly`\<`S` & `T`\>
