[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / QuerySchema

# Variable: QuerySchema

> `const` **QuerySchema**: `ZodObject`\<\{ `stream`: `ZodOptional`\<`ZodString`\>; `names`: `ZodOptional`\<`ZodArray`\<`ZodString`\>\>; `before`: `ZodOptional`\<`ZodNumber`\>; `after`: `ZodOptional`\<`ZodNumber`\>; `limit`: `ZodOptional`\<`ZodNumber`\>; `created_before`: `ZodOptional`\<`ZodDate`\>; `created_after`: `ZodOptional`\<`ZodDate`\>; `backward`: `ZodOptional`\<`ZodBoolean`\>; `correlation`: `ZodOptional`\<`ZodString`\>; \}, `$strip`\>

Defined in: [libs/act/src/types/schemas.ts:86](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/schemas.ts#L86)

Options to query the all stream
- `stream?` filter by stream
- `names?` filter by event names
- `before?` filter events before this id
- `after?` filter events after this id
- `limit?` limit the number of events to return
- `created_before?` filter events created before this date/time
- `created_after?` filter events created after this date/time
- `backward?` order descending when true
- `correlation?` filter by correlation
- `actor?` filter by actor id (mainly used to reduce process managers)
- `loading?` flag when loading to optimize queries
