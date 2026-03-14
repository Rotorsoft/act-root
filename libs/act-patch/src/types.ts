/**
 * A generic schema definition (plain object shape).
 */
export type Schema = Record<string, any>;

/**
 * Recursive partial for patching state objects.
 * Properties set to undefined or null are deleted.
 */
export type Patch<T> = {
  [K in keyof T]?: T[K] extends Schema ? Patch<T[K]> | null : T[K] | null;
};

/**
 * Recursive deep partial — useful for consumer APIs.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, any> ? DeepPartial<T[K]> : T[K];
};
