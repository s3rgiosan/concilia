import { describe, expect, it } from "vitest";
import { makeReasons } from "../test/fixtures";
import { isReasonId, newReasonId, reasonLabel, reasonName } from "./reasons";

describe("isReasonId", () => {
  it("accepts shipped ids and custom ids", () => {
    for (const id of ["bank_fee", "salary", "transfer", "refund", "no_receipt", "reason:abc"]) {
      expect(isReasonId(id)).toBe(true);
    }
  });

  it("rejects match notes and an empty custom id", () => {
    for (const notes of ["", "manual_match", "rule_match (acme)", "reason:", "reason: "]) {
      expect(isReasonId(notes)).toBe(false);
    }
  });
});

describe("newReasonId", () => {
  it("makes a custom reason id", () => {
    expect(isReasonId(newReasonId())).toBe(true);
    expect(newReasonId()).not.toBe(newReasonId());
  });
});

describe("reasonName", () => {
  it("uses the language's name, then the other language's", () => {
    const reason = { id: "reason:a", names: { en: "Lunch", pt: "" } };
    expect(reasonName(reason, "en")).toBe("Lunch");
    expect(reasonName(reason, "pt")).toBe("Lunch");
    expect(reasonName({ id: "salary", names: { en: "Salary", pt: "Salário" } }, "pt")).toBe("Salário");
  });
});

describe("reasonLabel", () => {
  it("names a deleted reason as Other", () => {
    expect(reasonLabel(makeReasons(), "transfer", "pt")).toBe("Transferência");
    expect(reasonLabel(makeReasons(), "reason:gone", "en")).toBe("Other");
  });
});
