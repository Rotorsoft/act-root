[**Act Framework Documentation v0.0.1**](README.md)

***

[Act Framework Documentation](README.md) / [act/src](act.src.md) / Errors

# Variable: Errors

> `const` **Errors**: `object`

Defined in: [libs/act/src/types/errors.ts:9](https://github.com/Rotorsoft/act-root/blob/62fab56d51bbe483c1ba64b9cb3720e282a9a947/libs/act/src/types/errors.ts#L9)

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
