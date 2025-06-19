[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / dispose

# Function: dispose()

> **dispose**(`disposer?`): (`code?`) => `Promise`\<`void`\>

Defined in: [libs/act/src/ports.ts:63](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/ports.ts#L63)

Registers resource disposers that are triggered on process exit

## Parameters

### disposer?

[`Disposer`](../type-aliases/Disposer.md)

the disposer function

## Returns

a function that triggers all registered disposers and terminates the process

> (`code?`): `Promise`\<`void`\>

### Parameters

#### code?

`"ERROR"` | `"EXIT"`

### Returns

`Promise`\<`void`\>
