[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / state

# Function: state()

> **state**\<`S`\>(`name`, `state`): [`StateBuilder`](../type-aliases/StateBuilder.md)\<`S`\>

Defined in: [libs/act/src/state-builder.ts:76](https://github.com/Rotorsoft/act-root/blob/b40f67575d048d860d7c67a52d36c927803922d7/libs/act/src/state-builder.ts#L76)

Fluent interface for defining a strongly-typed state machine using Zod schemas.

This builder helps you model a system where:
- You start by defining the state schema with `state(name, zodSchema)`
- Then, provide the initial state using `.init(() => defaultState)`
- Declare the event types your system can emit using `.emits({ ... })`
- Define how emitted events update state with `.patch({ ... })`
- Define actions using `.on("actionName", actionSchema)`
    - Optionally constrain the action with `.given([...invariants])`
    - Then finalize the action behavior with `.emit(handler)`
- (Optional) Define a `.snap(snapshot => boolean)` function to reduce recomputations
- Finalize the state machine definition using `.build()`

Example usage:
```ts
const machine = state("machine", myStateSchema)
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.amount })
  })
  .on("increment", z.object({ by: z.number() }))
  .given([{ description: "must be positive", valid: (s, a) => a?.by > 0 }])
  .emit((action, state) => ({ type: "Incremented", amount: action.by }))
  .build();
```

## Type Parameters

### S

`S` *extends* [`Schema`](../type-aliases/Schema.md)

## Parameters

### name

`string`

### state

`ZodType`\<`S`\>

## Returns

[`StateBuilder`](../type-aliases/StateBuilder.md)\<`S`\>
