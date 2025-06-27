[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / buildSnapshotSchema

# Function: buildSnapshotSchema()

> **buildSnapshotSchema**\<`S`\>(`s`): `ZodObject`\<\{ `state`: `ZodReadonly`\<`ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>, `$strip`\>\>; `event`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>\]\>\>; `patches`: `ZodNumber`; `snaps`: `ZodNumber`; \}, `$strip`\>

Defined in: [libs/act/src/types/schemas.ts:52](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/schemas.ts#L52)

## Type Parameters

### S

`S` *extends* `Readonly`\<\{ `events`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](act.src.Variable.ZodEmpty.md)\>; `actions`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](act.src.Variable.ZodEmpty.md)\>; `state`: `ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>\>; \}\>

## Parameters

### s

`S`

## Returns

`ZodObject`\<\{ `state`: `ZodReadonly`\<`ZodObject`\<`Readonly`\<\{[`k`: `string`]: `$ZodType`\<`unknown`, `unknown`, `$ZodTypeInternals`\<`unknown`, `unknown`\>\>; \}\>, `$strip`\>\>; `event`: `ZodOptional`\<`ZodUnion`\<readonly \[`ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>, `ZodObject`\<\{ `name`: `ZodLiteral`\<`string`\>; `data`: `ZodRecord`\<`ZodString`, `ZodNever`\> \| `ZodObject`\<`Readonly`\<\{[`k`: ...]: ...; \}\>, `$strip`\>; `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<..., ...\>; \}, `$strip`\>\>; \}, `$strip`\>\]\>\>; `patches`: `ZodNumber`; `snaps`: `ZodNumber`; \}, `$strip`\>
