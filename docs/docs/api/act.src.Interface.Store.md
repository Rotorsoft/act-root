[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Store

# Interface: Store

Defined in: [libs/act/src/types/ports.ts:13](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L13)

## Extends

- [`Disposable`](act.src.TypeAlias.Disposable.md)

## Properties

### dispose

> **dispose**: [`Disposer`](act.src.TypeAlias.Disposer.md)

Defined in: [libs/act/src/types/ports.ts:11](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L11)

#### Inherited from

[`Disposable`](act.src.TypeAlias.Disposable.md).[`dispose`](act.src.TypeAlias.Disposable.md#dispose)

***

### seed()

> **seed**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:14](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L14)

#### Returns

`Promise`\<`void`\>

***

### drop()

> **drop**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:15](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L15)

#### Returns

`Promise`\<`void`\>

***

### commit()

> **commit**: \<`E`\>(`stream`, `msgs`, `meta`, `expectedVersion?`) => `Promise`\<[`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>[]\>

Defined in: [libs/act/src/types/ports.ts:18](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L18)

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

`Promise`\<[`Committed`](act.src.TypeAlias.Committed.md)\<`E`, keyof `E`\>[]\>

***

### query()

> **query**: \<`E`\>(`callback`, `query?`, `withSnaps?`) => `Promise`\<`number`\>

Defined in: [libs/act/src/types/ports.ts:24](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L24)

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

`boolean`

#### Returns

`Promise`\<`number`\>

***

### fetch()

> **fetch**: \<`E`\>(`limit`) => `Promise`\<[`Fetch`](act.src.TypeAlias.Fetch.md)\<`E`\>\>

Defined in: [libs/act/src/types/ports.ts:31](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L31)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](act.src.TypeAlias.Schemas.md)

#### Parameters

##### limit

`number`

#### Returns

`Promise`\<[`Fetch`](act.src.TypeAlias.Fetch.md)\<`E`\>\>

***

### lease()

> **lease**: (`leases`) => `Promise`\<[`Lease`](act.src.TypeAlias.Lease.md)[]\>

Defined in: [libs/act/src/types/ports.ts:32](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L32)

#### Parameters

##### leases

[`Lease`](act.src.TypeAlias.Lease.md)[]

#### Returns

`Promise`\<[`Lease`](act.src.TypeAlias.Lease.md)[]\>

***

### ack()

> **ack**: (`leases`) => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:33](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/ports.ts#L33)

#### Parameters

##### leases

[`Lease`](act.src.TypeAlias.Lease.md)[]

#### Returns

`Promise`\<`void`\>
