/** Whether two objects have the same keys holding identical values. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) {
    return true;
  }
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}
