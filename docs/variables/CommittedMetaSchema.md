[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / CommittedMetaSchema

# Variable: CommittedMetaSchema

> `const` **CommittedMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `id`: `ZodNumber`; `stream`: `ZodString`; `version`: `ZodNumber`; `created`: `ZodDate`; `meta`: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<...\>, `ZodObject`\<..., ...\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: ...; `name`: ...; `stream`: ...; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:36](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/schemas.ts#L36)
