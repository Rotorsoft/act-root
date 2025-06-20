[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / act

# Function: act()

> **act**\<`S`, `E`, `A`\>(`states`, `registry`): [`ActBuilder`](../type-aliases/ActBuilder.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act-builder.ts:60](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act-builder.ts#L60)

Creates an ActBuilder instance.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](../type-aliases/SchemaRegister.md)\<`A`\> = \{ \}

The type of state

### E

`E` *extends* [`Schemas`](../type-aliases/Schemas.md) = \{ \}

The type of events

### A

`A` *extends* [`Schemas`](../type-aliases/Schemas.md) = \{ \}

The type of actions

## Parameters

### states

`Set`\<`string`\> = `...`

### registry

[`Registry`](../type-aliases/Registry.md)\<`S`, `E`, `A`\> = `...`

## Returns

[`ActBuilder`](../type-aliases/ActBuilder.md)\<`S`, `E`, `A`\>
