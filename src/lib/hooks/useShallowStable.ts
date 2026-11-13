import { useState } from "react";
import { shallowEqual } from "../shallowEqual";

/** The first of the objects it has seen that is shallowly equal to `value`, so effects can depend on it. */
export function useShallowStable<T extends object>(value: T): T {
  const [stable, setStable] = useState(value);
  if (!shallowEqual(stable, value)) {
    setStable(value);
  }
  return stable;
}
