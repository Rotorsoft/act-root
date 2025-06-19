[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / EventMetaSchema

# Variable: EventMetaSchema

> `const` **EventMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<`ZodObject`\<\{ `stream`: `ZodString`; `actor`: `ZodReadonly`\<...\>; `expectedVersion`: `ZodOptional`\<...\>; \}, `$strip`\>\>, `ZodObject`\<\{ `name`: `ZodString`; \}, `$strip`\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: `ZodNumber`; `name`: `ZodString`; `stream`: `ZodString`; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:26](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/types/schemas.ts#L26)
