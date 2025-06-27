[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Act

# Class: Act\<S, E, A\>

Defined in: [libs/act/src/act.ts:30](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L30)

Act is the main orchestrator for event-sourced state machines.
It manages actions, reactions, event streams, and provides APIs for loading, querying, and draining events.

## Type Parameters

### S

`S` *extends* [`SchemaRegister`](act.src.TypeAlias.SchemaRegister.md)\<`A`\>

SchemaRegister for state

### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

Schemas for events

### A

`A` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

Schemas for actions

## Constructors

### Constructor

> **new Act**\<`S`, `E`, `A`\>(`registry`, `drainLimit`): `Act`\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act.ts:57](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L57)

#### Parameters

##### registry

[`Registry`](act.src.TypeAlias.Registry.md)\<`S`, `E`, `A`\>

##### drainLimit

`number`

#### Returns

`Act`\<`S`, `E`, `A`\>

## Properties

### registry

> `readonly` **registry**: [`Registry`](act.src.TypeAlias.Registry.md)\<`S`, `E`, `A`\>

Defined in: [libs/act/src/act.ts:58](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L58)

***

### drainLimit

> `readonly` **drainLimit**: `number`

Defined in: [libs/act/src/act.ts:59](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L59)

## Methods

### emit()

#### Call Signature

> **emit**(`event`, `args`): `boolean`

Defined in: [libs/act/src/act.ts:37](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L37)

##### Parameters

###### event

`"committed"`

###### args

`SnapshotArgs`

##### Returns

`boolean`

#### Call Signature

> **emit**(`event`, `args`): `boolean`

Defined in: [libs/act/src/act.ts:38](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L38)

##### Parameters

###### event

`"drained"`

###### args

[`Lease`](act.src.TypeAlias.Lease.md)[]

##### Returns

`boolean`

***

### on()

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:43](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L43)

##### Parameters

###### event

`"committed"`

###### listener

(`args`) => `void`

##### Returns

`this`

#### Call Signature

> **on**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:44](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L44)

##### Parameters

###### event

`"drained"`

###### listener

(`args`) => `void`

##### Returns

`this`

***

### off()

#### Call Signature

> **off**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:50](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L50)

##### Parameters

###### event

`"committed"`

###### listener

(`args`) => `void`

##### Returns

`this`

#### Call Signature

> **off**(`event`, `listener`): `this`

Defined in: [libs/act/src/act.ts:51](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L51)

##### Parameters

###### event

`"drained"`

###### listener

(`args`) => `void`

##### Returns

`this`

***

### do()

> **do**\<`K`\>(`action`, `target`, `payload`, `reactingTo?`, `skipValidation?`): `Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`S`\[`K`\], `E`\>\>

Defined in: [libs/act/src/act.ts:75](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L75)

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

[`Target`](act.src.TypeAlias.Target.md)

The target of the action

##### payload

`Readonly`\<`A`\[`K`\]\>

The payload of the action

##### reactingTo?

[`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>

The event that the action is reacting to

##### skipValidation?

`boolean` = `false`

Whether to skip validation

#### Returns

`Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`S`\[`K`\], `E`\>\>

The snapshot of the committed Event

***

### load()

> **load**\<`SX`, `EX`, `AX`\>(`state`, `stream`, `callback?`): `Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`SX`, `EX`\>\>

Defined in: [libs/act/src/act.ts:105](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L105)

Loads a snapshot of the state from the store.

#### Type Parameters

##### SX

`SX` *extends* [`Schema`](act.src.TypeAlias.Schema.md)

The type of state

##### EX

`EX` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

The type of events

##### AX

`AX` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

The type of actions

#### Parameters

##### state

[`State`](act.src.TypeAlias.State.md)\<`SX`, `EX`, `AX`\>

The state to load

##### stream

`string`

The stream to load

##### callback?

(`snapshot`) => `void`

The callback to call with the snapshot

#### Returns

`Promise`\<[`Snapshot`](act.src.TypeAlias.Snapshot.md)\<`SX`, `EX`\>\>

The snapshot of the loaded state

***

### query()

> **query**(`query`, `callback?`): `Promise`\<\{ `first?`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>; `last?`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>; `count`: `number`; \}\>

Defined in: [libs/act/src/act.ts:120](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L120)

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

`Promise`\<\{ `first?`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>; `last?`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>; `count`: `number`; \}\>

The query result

***

### drain()

> **drain**(): `Promise`\<`number`\>

Defined in: [libs/act/src/act.ts:183](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/act.ts#L183)

Drains events from the store.

#### Returns

`Promise`\<`number`\>

The number of drained events
