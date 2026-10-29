import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { FinalizeCounts } from "./effective";
import { finalizeAlert } from "./finalizeAlert";

const COUNTS: FinalizeCounts = { matched: 31, review: 2, unmatched: 5, total: 38 };

function alert({ counts = COUNTS, pending = 0, refused = 0 } = {}) {
  return finalizeAlert({ period: "March 2030", counts, pending, refused }, i18n.t, "en");
}

function lines(message: string): string[] {
  return message.split("\n\n");
}

describe("finalizeAlert", () => {
  it("names the month, how the receipts are sorted and the report", () => {
    const request = alert();
    expect(request.title).toBe("Finalize March 2030?");
    expect(lines(request.message)).toEqual([
      "38 receipts will be sorted: 31 matched, 2 still to review, and 5 unmatched.",
      "Concilia sorts the receipts into folders inside this month's receipts folder and saves the Excel report.",
      "To change decisions later, use Reconcile Again.",
    ]);
    expect(request).toMatchObject({ confirm: "Finalize", cancel: "Cancel", alternate: undefined });
  });

  it("says how many unreadable files stay in the receipts folder, only when there are some", () => {
    expect(lines(alert({ refused: 2 }).message)).toContain("2 files stay in the receipts folder because Concilia can't read them.");
    expect(lines(alert({ refused: 1 }).message)).toContain("1 file stays in the receipts folder because Concilia can't read it.");
    expect(alert().message).not.toMatch(/can't read/);
  });

  it("counts one receipt and none, leaving out empty groups", () => {
    expect(lines(alert({ counts: { matched: 1, review: 0, unmatched: 0, total: 1 } }).message)[0]).toBe("1 receipt will be sorted: 1 matched.");
    expect(lines(alert({ counts: { matched: 3, review: 0, unmatched: 2, total: 5 } }).message)[0]).toBe("5 receipts will be sorted: 3 matched and 2 unmatched.");
    expect(lines(alert({ counts: { matched: 0, review: 0, unmatched: 0, total: 0 } }).message)[0]).toBe("No receipts will be sorted.");
  });

  it("warns about transactions still needing a decision and offers Review Remaining", () => {
    const six = alert({ pending: 6 });
    expect(lines(six.message)).toContain("6 transactions still need a decision. They will be sorted as they are now.");
    expect(six.alternate).toBe("Review Remaining");
    expect(lines(alert({ pending: 1 }).message)).toContain("1 transaction still needs a decision. It will be sorted as it is now.");
    expect(alert().message).not.toMatch(/still need/);
  });
});
