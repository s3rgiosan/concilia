import { describe, expect, it } from "vitest";
import { shallowEqual } from "./shallowEqual";

describe("shallowEqual", () => {
  it("is true for the same object and for equal flat objects", () => {
    const a = { x: true, y: 1 };
    expect(shallowEqual(a, a)).toBe(true);
    expect(shallowEqual({ x: true, y: 1 }, { x: true, y: 1 })).toBe(true);
  });

  it("is false when a value or a key differs", () => {
    expect(shallowEqual({ x: true }, { x: false })).toBe(false);
    expect(shallowEqual<Record<string, boolean>>({ x: true }, { x: true, y: true })).toBe(false);
    expect(shallowEqual<Record<string, boolean>>({ x: true, y: true }, { x: true, z: true })).toBe(false);
  });
});
