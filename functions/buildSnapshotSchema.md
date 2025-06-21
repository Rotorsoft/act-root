[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / buildSnapshotSchema

# Function: buildSnapshotSchema()

> **buildSnapshotSchema**\<`S`\>(`s`): `ZodObject`\<\{ `state`: `ZodReadonly`\<`ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>, `$strip`\>\>; `event`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>\]\>\>; `patches`: `ZodNumber`; `snaps`: `ZodNumber`; \}, `$strip`\>

Defined in: [libs/act/src/types/schemas.ts:52](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/schemas.ts#L52)

## Type Parameters

### S

`S` *extends* `Readonly`\<\{ `events`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](../variables/ZodEmpty.md)\>; `actions`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](../variables/ZodEmpty.md)\>; `state`: `ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>\>; \}\>

## Parameters

### s

`S`

## Returns

`ZodObject`\<\{ `state`: `ZodReadonly`\<`ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>, `$strip`\>\>; `event`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>\]\>\>; `patches`: `ZodNumber`; `snaps`: `ZodNumber`; \}, `$strip`\>
