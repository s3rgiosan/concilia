import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { matchReason } from "./notes";

const t = i18n.t.bind(i18n);

describe("matchReason", () => {
  it.each([
    ["bank_fee", "Bank fee (auto)"],
    ["name_amount_match", "Name & amount match"],
    ["name_amount_date_match", "Name, amount & date match"],
    ["amount_match", "Amount match"],
    ["amount_date_match", "Amount & date match"],
    ["unknown_currency_match", "Amount match (currency unverified)"],
    ["manual_match", "Manual match"],
    ["filename_match", "Filename match — verify amounts"],
  ])("describes %s", (notes, text) => {
    expect(matchReason(notes, t)).toBe(text);
  });

  it("is empty without a note", () => {
    expect(matchReason("", t)).toBe("");
  });

  it("names the currency of a foreign-currency match", () => {
    expect(matchReason("fx_match (USD)", t)).toBe("Foreign-currency match (USD)");
  });

  it("names the vendor of a rule match", () => {
    expect(matchReason("rule_match (acme)", t)).toBe("Rule match (acme)");
    expect(matchReason("rule_match_amount (acme)", t)).toBe("Rule match, different amount (acme)");
  });

  it("keeps nested parentheses in the vendor of a rule match", () => {
    expect(matchReason("rule_match (acme (eu))", t)).toBe("Rule match (acme (eu))");
  });

  it("describes a rule or FX match without detail", () => {
    expect(matchReason("rule_match", t)).toBe("Rule match ()");
    expect(matchReason("fx_match", t)).toBe("Foreign-currency match ()");
  });


  it.each([
    ["1 receipts match name+amount", "1 receipt matches name & amount"],
    ["3 receipts match name+amount", "3 receipts match name & amount"],
    ["1 receipts match name+amount (unknown currency)", "1 receipt matches name & amount (currency unverified)"],
    ["2 receipts match name+amount (unknown currency)", "2 receipts match name & amount (currency unverified)"],
    ["1 receipts match amount", "1 receipt matches amount"],
    ["2 receipts match amount", "2 receipts match amount"],
    ["1 receipts match amount (unknown currency)", "1 receipt matches amount (currency unverified)"],
    ["4 receipts match amount (unknown currency)", "4 receipts match amount (currency unverified)"],
    ["1 receipts match by filename", "1 receipt matches by filename"],
    ["5 receipts match by filename", "5 receipts match by filename"],
  ])("counts %s", (notes, text) => {
    expect(matchReason(notes, t)).toBe(text);
  });

  it("counts FX receipts with their tolerance", () => {
    expect(matchReason("1 fx receipts within 10%", t)).toBe("1 foreign-currency receipt within 10%");
    expect(matchReason("3 fx receipts within 10%", t)).toBe("3 foreign-currency receipts within 10%");
  });

  it("shows unknown codes as they are", () => {
    expect(matchReason("something_new", t)).toBe("something_new");
    expect(matchReason("2 receipts match vibes", t)).toBe("2 receipts match vibes");
    expect(matchReason("custom (detail)", t)).toBe("custom (detail)");
  });
});

describe("matchReason for reasons", () => {
  it("names a reason id with the given lookup", () => {
    expect(matchReason("reason:lunch", t, (id) => `name of ${id}`)).toBe("name of reason:lunch");
    expect(matchReason("salary", t, () => "Salário")).toBe("Salário");
  });
});
