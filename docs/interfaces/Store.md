[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Store

# Interface: Store

Defined in: [libs/act/src/types/ports.ts:7](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L7)

## Extends

- [`Disposable`](../type-aliases/Disposable.md)

## Properties

### dispose

> **dispose**: [`Disposer`](../type-aliases/Disposer.md)

Defined in: [libs/act/src/types/ports.ts:5](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L5)

#### Inherited from

[`Disposable`](../type-aliases/Disposable.md).[`dispose`](../type-aliases/Disposable.md#dispose)

***

### seed()

> **seed**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:8](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L8)

#### Returns

`Promise`\<`void`\>

***

### drop()

> **drop**: () => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:9](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L9)

#### Returns

`Promise`\<`void`\>

***

### commit()

> **commit**: \<`E`\>(`stream`, `msgs`, `meta`, `expectedVersion?`) => `Promise`\<[`Committed`](../type-aliases/Committed.md)\<`E`, keyof `E`\>[]\>

Defined in: [libs/act/src/types/ports.ts:12](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L12)

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

Defined in: [libs/act/src/types/ports.ts:18](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L18)

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

Defined in: [libs/act/src/types/ports.ts:25](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L25)

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

Defined in: [libs/act/src/types/ports.ts:26](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L26)

#### Parameters

##### leases

[`Lease`](../type-aliases/Lease.md)[]

#### Returns

`Promise`\<[`Lease`](../type-aliases/Lease.md)[]\>

***

### ack()

> **ack**: (`leases`) => `Promise`\<`void`\>

Defined in: [libs/act/src/types/ports.ts:27](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/ports.ts#L27)

#### Parameters

##### leases

[`Lease`](../type-aliases/Lease.md)[]

#### Returns

`Promise`\<`void`\>
