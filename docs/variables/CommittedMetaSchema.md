[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / CommittedMetaSchema

# Variable: CommittedMetaSchema

> `const` **CommittedMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<...\>, `ZodObject`\<..., ...\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: ...; `name`: ...; `stream`: ...; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:36](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/schemas.ts#L36)
