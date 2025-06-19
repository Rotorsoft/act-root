[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / extend

# Function: extend()

> **extend**\<`S`, `T`\>(`source`, `schema`, `target?`): `Readonly`\<`S` & `T`\>

Defined in: [libs/act/src/utils.ts:88](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/utils.ts#L88)

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
