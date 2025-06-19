[**Act Framework Documentation v0.3.0**](../README.md)

***

[Act Framework Documentation](../globals.md) / Errors

# Variable: Errors

> `const` **Errors**: `object`

Defined in: [libs/act/src/types/errors.ts:9](https://github.com/Rotorsoft/act-root/blob/44434ac9e20b81fc5bbda127e1633a974aa78bcb/libs/act/src/types/errors.ts#L9)

Application error types
- `ERR_VALIDATION` schema validation error
- `ERR_INVARIANT` invariant validation error
- `ERR_CONCURRENCY` optimistic concurrency validation error on commits

## Type declaration

### ValidationError

> `readonly` **ValidationError**: `"ERR_VALIDATION"` = `"ERR_VALIDATION"`

### InvariantError

> `readonly` **InvariantError**: `"ERR_INVARIANT"` = `"ERR_INVARIANT"`

### ConcurrencyError

> `readonly` **ConcurrencyError**: `"ERR_CONCURRENCY"` = `"ERR_CONCURRENCY"`
