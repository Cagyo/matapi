export type DeepReadonly<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** Freezes every reachable catalog value, including nested arrays and records. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as DeepReadonly<T>;
  }

  const object = value as object;
  if (seen.has(object)) return value as DeepReadonly<T>;
  seen.add(object);

  for (const key of Reflect.ownKeys(object)) {
    deepFreeze(Reflect.get(object, key), seen);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}
