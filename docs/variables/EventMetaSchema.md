[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / EventMetaSchema

# Variable: EventMetaSchema

> `const` **EventMetaSchema**: `ZodReadonly`\<`ZodObject`\<\{ `correlation`: `ZodString`; `causation`: `ZodObject`\<\{ `action`: `ZodOptional`\<`ZodIntersection`\<`ZodReadonly`\<`ZodObject`\<\{ `stream`: `ZodString`; `actor`: `ZodReadonly`\<...\>; `expectedVersion`: `ZodOptional`\<...\>; \}, `$strip`\>\>, `ZodObject`\<\{ `name`: `ZodString`; \}, `$strip`\>\>\>; `event`: `ZodOptional`\<`ZodObject`\<\{ `id`: `ZodNumber`; `name`: `ZodString`; `stream`: `ZodString`; \}, `$strip`\>\>; \}, `$strip`\>; \}, `$strip`\>\>

Defined in: [libs/act/src/types/schemas.ts:26](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/schemas.ts#L26)
