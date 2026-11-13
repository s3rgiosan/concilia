import { describe, expect, it, vi } from "vitest";
import { longDate, shortDate } from "./dates";

describe("shortDate", () => {
  it("shows the day and the abbreviated month", () => {
    expect(shortDate("2030-03-04", "en")).toBe("4 Mar");
    expect(shortDate("2030-12-25", "en")).toBe("25 Dec");
  });

  it("uses Portuguese month names", () => {
    expect(shortDate("2030-03-04", "pt")).toBe("4 mar.");
  });

  it("falls back to English for other languages", () => {
    expect(shortDate("2030-03-04", "de")).toBe("4 Mar");
  });

  it("keeps text that is not an ISO date", () => {
    expect(shortDate("04/03/2030", "en")).toBe("04/03/2030");
    expect(shortDate("", "en")).toBe("");
  });
});

describe("longDate", () => {
  it("spells the month out with the year", () => {
    expect(longDate("2030-03-04", "en")).toBe("4 March 2030");
    expect(longDate("2030-03-04", "pt")).toBe("4 de março de 2030");
  });

  it("keeps text that is not an ISO date", () => {
    expect(longDate("unknown", "pt")).toBe("unknown");
  });
});

describe("formatter caching", () => {
  it("builds one formatter per locale and options", async () => {
    vi.resetModules();
    const fresh = await import("./dates");
    const construct = vi.spyOn(Intl, "DateTimeFormat");
    for (let day = 1; day <= 28; day += 1) {
      const iso = `2030-03-${String(day).padStart(2, "0")}`;
      fresh.shortDate(iso, "en");
      fresh.longDate(iso, "en");
      fresh.shortDate(iso, "pt");
    }
    expect(construct).toHaveBeenCalledTimes(3);
    construct.mockRestore();
  });
});
