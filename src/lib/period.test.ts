import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { defaultPeriod, MONTHS, monthOptions, periodLabel, yearOptions } from "./period";

describe("defaultPeriod", () => {
  it("is the previous month", () => {
    expect(defaultPeriod(new Date(2030, 3, 15))).toEqual({ year: "2030", month: "03" });
    expect(defaultPeriod(new Date(2030, 10, 1))).toEqual({ year: "2030", month: "10" });
    expect(defaultPeriod(new Date(2030, 11, 31))).toEqual({ year: "2030", month: "11" });
  });

  it("is December of the previous year in January", () => {
    expect(defaultPeriod(new Date(2030, 0, 10))).toEqual({ year: "2029", month: "12" });
  });

  it("handles a day the previous month lacks", () => {
    expect(defaultPeriod(new Date(2030, 2, 31))).toEqual({ year: "2030", month: "02" });
  });
});

describe("yearOptions", () => {
  it("lists this year and the two before, newest first", () => {
    expect(yearOptions(new Date(2030, 5, 1))).toEqual(["2030", "2029", "2028"]);
  });
});

describe("monthOptions", () => {
  it("labels every month", () => {
    const options = monthOptions(i18n.t);
    expect(options.map((o) => o.value)).toEqual([...MONTHS]);
    expect(options[0]).toEqual({ value: "01", label: "January" });
    expect(options[11]).toEqual({ value: "12", label: "December" });
  });
});

describe("periodLabel", () => {
  it("names the month and year", () => {
    expect(periodLabel({ year: "2030", month: "03" }, i18n.t)).toBe("March 2030");
  });
});
