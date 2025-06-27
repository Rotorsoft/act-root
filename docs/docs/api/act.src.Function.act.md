[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / act

# Function: act()

> **act**\<`S`, `E`, `A`\>(`states`, `registry`): [`ActBuilder`](act.src.TypeAlias.ActBuilder.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act-builder.ts:60](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act-builder.ts#L60)

Creates an ActBuilder instance.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](act.src.TypeAlias.SchemaRegister.md)\<`A`\> = \{ \}

The type of state

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md) = \{ \}

The type of events

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md) = \{ \}

The type of actions

## Parameters

### states

`Set`\<`string`\> = `...`

### registry

[`Registry`](act.src.TypeAlias.Registry.md)\<`S`, `E`, `A`\> = `...`

## Returns

[`ActBuilder`](act.src.TypeAlias.ActBuilder.md)\<`S`, `E`, `A`\>
