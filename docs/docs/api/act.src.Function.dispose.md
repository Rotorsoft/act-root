[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / dispose

# Function: dispose()

> **dispose**(`disposer?`): (`code?`) => `Promise`\<`void`\>

Defined in: [libs/act/src/ports.ts:63](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/ports.ts#L63)

Registers resource disposers that are triggered on process exit

## Parameters

### disposer?

[`Disposer`](act.src.TypeAlias.Disposer.md)

the disposer function

## Returns

a function that triggers all registered disposers and terminates the process

> (`code?`): `Promise`\<`void`\>

### Parameters

#### code?

`"ERROR"` | `"EXIT"`

### Returns

`Promise`\<`void`\>
