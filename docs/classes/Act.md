[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Act

# Class: Act\<S, E, A\>

Defined in: [libs/act/src/act.ts:30](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L30)

Act is the main orchestrator for event-sourced state machines.
It manages actions, reactions, event streams, and provides APIs for loading, querying, and draining events.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](../type-aliases/SchemaRegister.md)\<`A`\>

SchemaRegister for state

### E

`E` *extends* [`Schemas`](../type-aliases/Schemas.md)

Schemas for events

### A

`A` *extends* [`Schemas`](../type-aliases/Schemas.md)

Schemas for actions

## Constructors

### Constructor

> **new Act**\<`S`, `E`, `A`\>(`registry`, `drainLimit`): `Act`\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act.ts:50](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L50)

#### Parameters

##### registry

[`Registry`](../type-aliases/Registry.md)\<`S`, `E`, `A`\>

##### drainLimit

`number`

#### Returns

`Act`\<`S`, `E`, `A`\>

## Properties

### registry

> `readonly` **registry**: [`Registry`](../type-aliases/Registry.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act.ts:51](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L51)

***

### drainLimit

> `readonly` **drainLimit**: `number`

Defined in: [libs/act/src/act.ts:52](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L52)

## Methods

### emit()

#### Call Signature

> **emit**(`event`, `args`): `boolean`

Defined in: [libs/act/src/act.ts:37](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L37)

##### Parameters

###### event

`"committed"`

###### args

`SnapshotArgs`

##### Returns

`boolean`

#### Call Signature

> **emit**(`event`, `args`): `boolean`

Defined in: [libs/act/src/act.ts:38](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L38)

##### Parameters

###### event

`"drained"`

###### args

[`Lease`](../type-aliases/Lease.md)[]

##### Returns

`boolean`

***

### on()

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:43](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L43)

##### Parameters

###### event

`"committed"`

###### listener

(`args`) => `void`

##### Returns

`this`

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:44](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L44)

##### Parameters

###### event

`"drained"`

###### listener

(`args`) => `void`

##### Returns

`this`

***

### do()

> **do**\<`K`\>(`action`, `target`, `payload`, `reactingTo?`, `skipValidation?`): `Promise`\<[`Snapshot`](../type-aliases/Snapshot.md)\<`S`\[`K`\], `E`\>\>

Defined in: [libs/act/src/act.ts:68](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L68)

Executes an action and emits an event to be committed by the store.

#### Type Parameters

##### K

`K` *extends* `string` \| `number` \| `symbol`

The type of action to execute

#### Parameters

##### action

`K`

The action to execute

##### target

[`Target`](../type-aliases/Target.md)

The target of the action

##### payload

`Readonly`\<`A`\[`K`\]\>

The payload of the action

##### reactingTo?

[`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>

The event that the action is reacting to

##### skipValidation?

`boolean` = `false`

Whether to skip validation

#### Returns

`Promise`\<[`Snapshot`](../type-aliases/Snapshot.md)\<`S`\[`K`\], `E`\>\>

The snapshot of the committed Event

***

### load()

> **load**\<`SX`, `EX`, `AX`\>(`state`, `stream`, `callback?`): `Promise`\<[`Snapshot`](../type-aliases/Snapshot.md)\<`SX`, `EX`\>\>

Defined in: [libs/act/src/act.ts:98](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L98)

Loads a snapshot of the state from the store.

#### Type Parameters

##### SX

`SX` *extends* [`Schema`](../type-aliases/Schema.md)

The type of state

##### EX

`EX` *extends* [`Schemas`](../type-aliases/Schemas.md)

The type of events

##### AX

`AX` *extends* [`Schemas`](../type-aliases/Schemas.md)

The type of actions

#### Parameters

##### state

[`State`](../type-aliases/State.md)\<`SX`, `EX`, `AX`\>

The state to load

##### stream

`string`

The stream to load

##### callback?

(`snapshot`) => `void`

The callback to call with the snapshot

#### Returns

`Promise`\<[`Snapshot`](../type-aliases/Snapshot.md)\<`SX`, `EX`\>\>

The snapshot of the loaded state

***

### query()

> **query**(`query`, `callback?`): `Promise`\<\{ `first?`: [`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>; `last?`: [`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>; `count`: `number`; \}\>

Defined in: [libs/act/src/act.ts:113](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L113)

Queries the store for events.

#### Parameters

##### query

The query to execute

###### stream?

`string` = `...`

###### names?

`string`[] = `...`

###### before?

`number` = `...`

###### after?

`number` = `...`

###### limit?

`number` = `...`

###### created_before?

`Date` = `...`

###### created_after?

`Date` = `...`

###### backward?

`boolean` = `...`

###### correlation?

`string` = `...`

##### callback?

(`event`) => `void`

The callback to call with the events

#### Returns

`Promise`\<\{ `first?`: [`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>; `last?`: [`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>; `count`: `number`; \}\>

The query result

***

### drain()

> **drain**(): `Promise`\<`number`\>

Defined in: [libs/act/src/act.ts:177](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/act.ts#L177)

Drains events from the store.

#### Returns

`Promise`\<`number`\>

The number of drained events
