/**
 * Whether a value is an ordinary object, which a patch merges into. Decided by
 * prototype, not by `value.constructor`: an own key named `constructor` (a
 * record keyed by user text can hold one) would shadow that.
 */
export const is_plain = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
