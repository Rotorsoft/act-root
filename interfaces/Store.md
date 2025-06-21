[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Store

# Interface: Store

Defined in: [libs/act/src/types/ports.ts:13](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L13)

## Extends

- [`Disposable`](../type-aliases/Disposable.md)

## Properties

### dispose

> **dispose**: [`Disposer`](../type-aliases/Disposer.md)

Defined in: [libs/act/src/types/ports.ts:11](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L11)

#### Inherited from

[`Disposable`](../type-aliases/Disposable.md).[`dispose`](../type-aliases/Disposable.md#dispose)

***

### seed()

> **seed**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:14](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L14)

#### Returns

`Promise`\<`void`\>

***

### drop()

> **drop**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:15](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L15)

#### Returns

`Promise`\<`void`\>

***

### commit()

> **commit**: \<`E`\>(`stream`, `msgs`, `meta`, `expectedVersion?`) => `Promise`\<[`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>[]\>

Defined in: [libs/act/src/types/ports.ts:18](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L18)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](../type-aliases/Schemas.md)

#### Parameters

##### stream

`string`

##### msgs

[`Message`](../type-aliases/Message.md)\<`E`, keyof `E`\>[]

##### meta

[`EventMeta`](../type-aliases/EventMeta.md)

##### expectedVersion?

`number`

#### Returns

`Promise`\<[`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>[]\>

***

### query()

> **query**: \<`E`\>(`callback`, `query?`, `withSnaps?`) => `Promise`\<`number`\>

Defined in: [libs/act/src/types/ports.ts:24](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L24)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](../type-aliases/Schemas.md)

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

> **fetch**: \<`E`\>(`limit`) => `Promise`\<[`Fetch`](../type-aliases/Fetch.md)\<`E`\>\>

Defined in: [libs/act/src/types/ports.ts:31](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L31)

#### Type Parameters

##### E

`E` *extends* [`Schemas`](../type-aliases/Schemas.md)

#### Parameters

##### limit

`number`

#### Returns

`Promise`\<[`Fetch`](../type-aliases/Fetch.md)\<`E`\>\>

***

### lease()

> **lease**: (`leases`) => `Promise`\<[`Lease`](../type-aliases/Lease.md)[]\>

Defined in: [libs/act/src/types/ports.ts:32](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L32)

#### Parameters

##### leases

[`Lease`](../type-aliases/Lease.md)[]

#### Returns

`Promise`\<[`Lease`](../type-aliases/Lease.md)[]\>

***

### ack()

> **ack**: (`leases`) => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:33](https://github.com/Rotorsoft/act-root/blob/ecf1ab2f895c5bdf2d70db49738046df56c78030/libs/act/src/types/ports.ts#L33)

#### Parameters

##### leases

[`Lease`](../type-aliases/Lease.md)[]

#### Returns

`Promise`\<`void`\>
