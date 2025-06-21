[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / StateSchema

# Type Alias: StateSchema

> **StateSchema** = `Readonly`\<\{ `events`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](../variables/ZodEmpty.md)\>; `actions`: `Record`\<`string`, `ZodObject`\<`ZodRawShape`\> \| *typeof* [`ZodEmpty`](../variables/ZodEmpty.md)\>; `state`: `ZodObject`\<`ZodRawShape`\>; \}\>

Defined in: [libs/act/src/types/schemas.ts:46](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/schemas.ts#L46)
