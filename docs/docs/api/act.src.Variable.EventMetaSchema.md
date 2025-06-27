[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / EventMetaSchema

# Variable: EventMetaSchema

> `const` **EventMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<`ZodObject`\<\{ `stream`: `ZodString`; `actor`: `ZodReadonly`\<...\>; `expectedVersion`: `ZodOptional`\<...\>; \}, `$strip`\>\>, `ZodObject`\<\{ `name`: `ZodString`; \}, `$strip`\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: `ZodNumber`; `name`: `ZodString`; `stream`: `ZodString`; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:26](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/schemas.ts#L26)
