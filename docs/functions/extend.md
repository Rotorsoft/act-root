[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / extend

# Function: extend()

> **extend**\<`S`, `T`\>(`source`, `schema`, `target?`): `Readonly`\<`S` & `T`\>

Defined in: [libs/act/src/utils.ts:88](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/utils.ts#L88)

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
