import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { remainingMs, remainingText, type Sample } from "./eta";

function samples(...pairs: [number, number][]): Sample[] {
  return pairs.map(([time, current]) => ({ time, current }));
}

describe("remainingMs", () => {
  it("waits for three receipts", () => {
    expect(remainingMs([], 10)).toBeNull();
    expect(remainingMs(samples([0, 0], [1000, 1], [2000, 2]), 10)).toBeNull();
  });

  it("extrapolates the measured rate", () => {
    expect(remainingMs(samples([0, 0], [1000, 1], [2000, 2], [3000, 3]), 10)).toBe(7000);
  });

  it("measures over the latest samples only", () => {
    const burst = samples([0, 0], [10, 20]);
    const steady = Array.from({ length: 10 }, (_, i) => ({ time: 10 + (i + 1) * 2000, current: 21 + i }));
    expect(remainingMs([...burst, ...steady], 40)).toBe(10 * 2000);
  });

  it("has nothing to say once every receipt is read or without a rate", () => {
    expect(remainingMs(samples([0, 0], [1000, 10]), 10)).toBeNull();
    expect(remainingMs(samples([1000, 5]), 10)).toBeNull();
  });
});

describe("remainingText", () => {
  it("rounds to whole minutes", () => {
    expect(remainingText(150_000, i18n.t)).toBe("About 3 min left");
    expect(remainingText(60_000, i18n.t)).toBe("About 1 min left");
  });

  it("says less than a minute under 60 seconds", () => {
    expect(remainingText(59_000, i18n.t)).toBe("Less than a minute left");
  });
});
