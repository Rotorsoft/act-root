[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / CommittedMetaSchema

# Variable: CommittedMetaSchema

> `const` **CommittedMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<...\>, `ZodObject`\<..., ...\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: ...; `name`: ...; `stream`: ...; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:36](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/schemas.ts#L36)
