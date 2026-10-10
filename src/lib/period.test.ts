import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { PeriodSummary, Summary } from "./tauri";
import {
  defaultPeriod,
  emptySummary,
  groupByYear,
  isReviewable,
  mergePeriods,
  MONTHS,
  monthOptions,
  parsePeriodKey,
  periodKey,
  periodLabel,
  runSummaryText,
  statusLine,
  yearOptions,
} from "./period";

function summary(year: string, month: string, patch: Partial<PeriodSummary> = {}): PeriodSummary {
  return { ...emptySummary({ year, month }), ...patch };
}

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
  it("lists next year down to 2000, newest first", () => {
    const years = yearOptions(new Date(2030, 5, 1));
    expect(years.slice(0, 3)).toEqual(["2031", "2030", "2029"]);
    expect(years[years.length - 1]).toBe("2000");
    expect(years).toHaveLength(32);
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

describe("periodKey", () => {
  it("joins the year and month", () => {
    expect(periodKey({ year: "2030", month: "03" })).toBe("2030-03");
  });

  it("reads back the month it names", () => {
    expect(parsePeriodKey("2030-03")).toEqual({ year: "2030", month: "03" });
    expect(parsePeriodKey("2030-12")).toEqual({ year: "2030", month: "12" });
  });

  it("rejects anything else", () => {
    for (const key of ["", "2030-13", "2030-00", "2030-3", "30-03", "2030-03-01", "march"]) {
      expect(parsePeriodKey(key), key).toBeNull();
    }
  });
});

describe("mergePeriods", () => {
  it("adds the extra months as empty, each once, newest first", () => {
    const listed = [summary("2030", "02", { status: "finalized", receipts: 12 }), summary("2029", "12", { status: "ready" })];
    const merged = mergePeriods(listed, [
      { year: "2030", month: "03" },
      { year: "2030", month: "02" },
      { year: "2030", month: "03" },
    ]);
    expect(merged.map(periodKey)).toEqual(["2030-03", "2030-02", "2029-12"]);
    expect(merged[0]).toEqual(emptySummary({ year: "2030", month: "03" }));
    expect(merged[1].status).toBe("finalized");
  });

  it("orders the listing newest first", () => {
    const merged = mergePeriods([summary("2028", "05"), summary("2030", "01"), summary("2030", "11")], []);
    expect(merged.map(periodKey)).toEqual(["2030-11", "2030-01", "2028-05"]);
  });
});

describe("groupByYear", () => {
  it("groups consecutive months under their year", () => {
    const groups = groupByYear([summary("2030", "03"), summary("2030", "01"), summary("2029", "12")]);
    expect(groups.map((g) => [g.year, g.periods.map((p) => p.month)])).toEqual([
      ["2030", ["03", "01"]],
      ["2029", ["12"]],
    ]);
  });

  it("is empty without months", () => {
    expect(groupByYear([])).toEqual([]);
  });
});

describe("statusLine", () => {
  it("describes each status with a dot", () => {
    expect(statusLine(summary("2030", "03"), i18n.t)).toEqual({ tone: "gray", label: "No receipts" });
    expect(statusLine(summary("2030", "03", { status: "ready" }), i18n.t)).toEqual({ tone: "yellow", label: "Ready" });
    expect(statusLine(summary("2030", "03", { status: "ready", receipts: 1 }), i18n.t).label).toBe("Ready · 1 receipt");
    expect(statusLine(summary("2030", "03", { status: "ready", receipts: 38 }), i18n.t).label).toBe("Ready · 38 receipts");
    expect(statusLine(summary("2030", "03", { status: "in_review", pending: 6 }), i18n.t)).toEqual({ tone: "orange", label: "In review · 6 to decide" });
    expect(statusLine(summary("2030", "03", { status: "in_review" }), i18n.t).label).toBe("In review");
    expect(statusLine(summary("2030", "03", { status: "finalized" }), i18n.t)).toEqual({ tone: "green", label: "Finalized" });
  });
});

describe("isReviewable", () => {
  it("holds for matched months only", () => {
    expect(isReviewable(summary("2030", "03", { status: "in_review" }))).toBe(true);
    expect(isReviewable(summary("2030", "03", { status: "finalized" }))).toBe(true);
    expect(isReviewable(summary("2030", "03", { status: "ready" }))).toBe(false);
    expect(isReviewable(summary("2030", "03"))).toBe(false);
  });
});

describe("runSummaryText", () => {
  const run: Summary = {
    totalTransactions: 40,
    matched: 30,
    review: 6,
    unmatched: 4,
    bankFees: 0,
    totalReceipts: 1,
    matchedReceipts: 1,
    reviewReceipts: 0,
    unmatchedReceipts: 0,
    matchRate: 75,
  };

  it("counts transactions and receipts and gives the match rate", () => {
    expect(runSummaryText(run, "en", i18n.t)).toBe("40 transactions · 1 receipt · 75% matched");
    expect(runSummaryText({ ...run, totalTransactions: 1, totalReceipts: 0 }, "en", i18n.t)).toBe("1 transaction · 0 receipts · 75% matched");
  });

  it("writes the percentage in the language of the text", async () => {
    await i18n.changeLanguage("pt");
    try {
      expect(runSummaryText(run, "pt", i18n.t)).toBe("40 transações · 1 recibo · 75\u00a0% associadas");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
