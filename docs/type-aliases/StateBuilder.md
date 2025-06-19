[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / StateBuilder

# Type Alias: StateBuilder\<S\>

> **StateBuilder**\<`S`\> = `object`

Defined in: [libs/act/src/state-builder.ts:16](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/state-builder.ts#L16)

## Type Parameters

### S

`S` *extends* [`Schema`](Schema.md)

## Properties

### init()

> **init**: (`init`) => `object`

Defined in: [libs/act/src/state-builder.ts:17](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/state-builder.ts#L17)

#### Parameters

##### init

() => `Readonly`\<`S`\>

#### Returns

`object`

##### emits()

> **emits**: \<`E`\>(`events`) => `object`

###### Type Parameters

###### E

`E` *extends* [`Schemas`](Schemas.md)

###### Parameters

###### events

[`ZodTypes`](ZodTypes.md)\<`E`\>

###### Returns

`object`

###### patch()

> **patch**: (`patch`) => [`ActionBuilder`](ActionBuilder.md)\<`S`, `E`, \{ \}\>

###### Parameters

###### patch

[`PatchHandlers`](PatchHandlers.md)\<`S`, `E`\>

###### Returns

[`ActionBuilder`](ActionBuilder.md)\<`S`, `E`, \{ \}\>
