[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / StateBuilder

# Type Alias: StateBuilder\<S\>

> **StateBuilder**\<`S`\> = `object`

Defined in: [libs/act/src/state-builder.ts:16](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L16)

## Type Parameters

### S

`S` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

## Properties

### init()

> **init**: (`init`) => `object`

Defined in: [libs/act/src/state-builder.ts:17](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/state-builder.ts#L17)

#### Parameters

##### init

() => `Readonly`\<`S`\>

#### Returns

`object`

##### emits()

> **emits**: \<`E`\>(`events`) => `object`

###### Type Parameters

###### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

###### Parameters

###### events

[`ZodTypes`](act.src.TypeAlias.ZodTypes.md)\<`E`\>

###### Returns

`object`

###### patch()

> **patch**: (`patch`) => [`ActionBuilder`](act.src.TypeAlias.ActionBuilder.md)\<`S`, `E`, \{ \}\>

###### Parameters

###### patch

[`PatchHandlers`](act.src.TypeAlias.PatchHandlers.md)\<`S`, `E`\>

###### Returns

[`ActionBuilder`](act.src.TypeAlias.ActionBuilder.md)\<`S`, `E`, \{ \}\>
