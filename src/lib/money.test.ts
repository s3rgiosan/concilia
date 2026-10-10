import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMoney, formatPercent, formatSignedMoney } from "./money";

const NBSP = " ";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatMoney", () => {
  it("formats euros in English", () => {
    expect(formatMoney(1000, "EUR", "en")).toBe("€10.00");
    expect(formatMoney(123456, "EUR", "en")).toBe("€1,234.56");
  });

  it("formats euros in Portuguese", () => {
    expect(formatMoney(1000, "EUR", "pt")).toBe(`10,00${NBSP}€`);
  });

  it("formats negative amounts", () => {
    expect(formatMoney(-2500, "EUR", "en")).toBe("-€25.00");
  });

  it("formats other currencies", () => {
    expect(formatMoney(1000, "USD", "en")).toBe("US$10.00");
    expect(formatMoney(1000, "GBP", "en")).toBe("£10.00");
    expect(formatMoney(1000, "USD", "pt")).toBe(`10,00${NBSP}US$`);
  });

  it("uses English for an unknown language", () => {
    expect(formatMoney(1000, "EUR", "de")).toBe("€10.00");
  });

  it("falls back to euros for a malformed currency", () => {
    expect(formatMoney(1000, "usd", "en")).toBe("€10.00");
    expect(formatMoney(1000, "EURO", "en")).toBe("€10.00");
    expect(formatMoney(1000, "", "en")).toBe("€10.00");
  });

  it("falls back to euros without a currency", () => {
    expect(formatMoney(1000, null, "en")).toBe("€10.00");
  });

  it("shows the plain amount and code when the formatter fails", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new RangeError("unsupported");
    });
    expect(formatMoney(1000, "USD", "en")).toBe("10.00 USD");
    expect(formatMoney(1000, null, "en")).toBe("10.00");
  });
});

describe("formatSignedMoney", () => {
  it("signs income and expenses", () => {
    expect(formatSignedMoney(50000, "EUR", "en")).toBe("+€500.00");
    expect(formatSignedMoney(-1000, "EUR", "en")).toBe("-€10.00");
    expect(formatSignedMoney(-1000, "EUR", "pt")).toBe(`-10,00${NBSP}€`);
  });

  it("leaves zero unsigned", () => {
    expect(formatSignedMoney(0, "EUR", "en")).toBe("€0.00");
  });

  it("keeps the sign when the formatter fails", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new RangeError("unsupported");
    });
    expect(formatSignedMoney(1000, "EUR", "en")).toBe("+10.00 EUR");
    expect(formatSignedMoney(-1000, "EUR", "en")).toBe("-10.00 EUR");
  });
});

describe("formatPercent", () => {
  it("formats a whole percentage in each language", () => {
    expect(formatPercent(74, "en")).toBe("74%");
    expect(formatPercent(74, "pt")).toBe(`74${NBSP}%`);
    expect(formatPercent(0, "en")).toBe("0%");
  });
});
