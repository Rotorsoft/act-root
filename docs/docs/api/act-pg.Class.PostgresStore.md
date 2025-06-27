[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act-pg](act-pg.md) / PostgresStore

# Class: PostgresStore

Defined in: [libs/act-pg/src/PostgresStore.ts:41](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L41)

## Implements

- [`Store`](act.src.Interface.Store.md)

## Constructors

### Constructor

> **new PostgresStore**(`config`): `PostgresStore`

Defined in: [libs/act-pg/src/PostgresStore.ts:45](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L45)

#### Parameters

##### config

`Partial`\<`Config`\> = `{}`

#### Returns

`PostgresStore`

## Properties

### config

> `readonly` **config**: `Config`

Defined in: [libs/act-pg/src/PostgresStore.ts:43](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L43)

## Methods

### dispose()

> **dispose**(): `Promise`\<`void`\>

Defined in: [libs/act-pg/src/PostgresStore.ts:50](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L50)

#### Returns

`Promise`\<`void`\>

#### Implementation of

`Store.dispose`

***

### seed()

> **seed**(): `Promise`\<`void`\>

Defined in: [libs/act-pg/src/PostgresStore.ts:54](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L54)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`seed`](act.src.Interface.Store.md#seed)

***

### drop()

> **drop**(): `Promise`\<`void`\>

Defined in: [libs/act-pg/src/PostgresStore.ts:128](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L128)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`drop`](act.src.Interface.Store.md#drop)

***

### query()

> **query**\<`E`\>(`callback`, `query?`, `withSnaps?`): `Promise`\<`number`\>

Defined in: [libs/act-pg/src/PostgresStore.ts:148](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L148)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

#### Parameters

##### callback

(`event`) => `void`

##### query?

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

##### withSnaps?

`boolean` = `false`

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`query`](act.src.Interface.Store.md#query)

***

### commit()

> **commit**\<`E`\>(`stream`, `msgs`, `meta`, `expectedVersion?`): `Promise`\<[`Message`](act.src.TypeAlias.Message.md)\<`E`, keyof `E`\> & `Readonly`\<\{ `id`: `number`; `stream`: `string`; `version`: `number`; `created`: `Date`; `meta`: `Readonly`\<\{ `correlation`: `string`; `causation`: \{ `action?`: `Readonly`\<...\> & `object`; `event?`: \{ `id`: `number`; `name`: `string`; `stream`: `string`; \}; \}; \}\>; \}\>[]\>

Defined in: [libs/act-pg/src/PostgresStore.ts:218](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L218)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

#### Parameters

##### stream

`string`

##### msgs

[`Message`](act.src.TypeAlias.Message.md)\<`E`, keyof `E`\>[]

##### meta

[`EventMeta`](act.src.TypeAlias.EventMeta.md)

##### expectedVersion?

`number`

#### Returns

`Promise`\<[`Message`](act.src.TypeAlias.Message.md)\<`E`, keyof `E`\> & `Readonly`\<\{ `id`: `number`; `stream`: `string`; `version`: `number`; `created`: `Date`; `meta`: `Readonly`\<\{ `correlation`: `string`; `causation`: \{ `action?`: `Readonly`\<...\> & `object`; `event?`: \{ `id`: `number`; `name`: `string`; `stream`: `string`; \}; \}; \}\>; \}\>[]\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`commit`](act.src.Interface.Store.md#commit)

***

### fetch()

> **fetch**\<`E`\>(`limit`): `Promise`\<\{ `streams`: `string`[]; `events`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>[]; \}\>

Defined in: [libs/act-pg/src/PostgresStore.ts:283](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L283)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

#### Parameters

##### limit

`number`

#### Returns

`Promise`\<\{ `streams`: `string`[]; `events`: [`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>[]; \}\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`fetch`](act.src.Interface.Store.md#fetch)

***

### lease()

> **lease**(`leases`): `Promise`\<`object`[]\>

Defined in: [libs/act-pg/src/PostgresStore.ts:307](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L307)

#### Parameters

##### leases

[`Lease`](act.src.TypeAlias.Lease.md)[]

#### Returns

`Promise`\<`object`[]\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`lease`](act.src.Interface.Store.md#lease)

***

### ack()

> **ack**(`leases`): `Promise`\<`void`\>

Defined in: [libs/act-pg/src/PostgresStore.ts:363](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act-pg/src/PostgresStore.ts#L363)

#### Parameters

##### leases

[`Lease`](act.src.TypeAlias.Lease.md)[]

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Store`](act.src.Interface.Store.md).[`ack`](act.src.Interface.Store.md#ack)
