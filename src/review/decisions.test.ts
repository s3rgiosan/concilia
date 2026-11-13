import { describe, expect, it } from "vitest";
import { makeReceipt, makeTransaction } from "../test/fixtures";
import { addReceipt, assign, changedIds, confirm, forDraft, noReceipt, removeReceipt, unmatch } from "./decisions";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME" });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX" });

describe("confirm", () => {
  const tx = makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME, GLOBEX], notes: "2 receipts match amount" });

  it("matches the given receipt", () => {
    expect(confirm(tx, GLOBEX)).toEqual({
      status: "MATCHED",
      receipt_meta: [GLOBEX],
      receipt_files: [GLOBEX.file],
      notes: "2 receipts match amount",
    });
  });

  it("matches every candidate without a receipt", () => {
    expect(confirm(tx)).toEqual({
      status: "MATCHED",
      receipt_meta: [ACME, GLOBEX],
      receipt_files: [ACME.file, GLOBEX.file],
      notes: "2 receipts match amount",
    });
  });

  it("notes an amount match when the transaction has no note", () => {
    expect(confirm({ ...tx, notes: "" }, ACME).notes).toBe("amount_match");
  });
});

describe("addReceipt and removeReceipt", () => {
  const tx = makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME], notes: "amount_match" });

  it("adds a receipt after the ones the transaction holds", () => {
    expect(addReceipt(tx, GLOBEX)).toEqual({
      status: "MATCHED",
      receipt_meta: [ACME, GLOBEX],
      receipt_files: [ACME.file, GLOBEX.file],
      notes: "manual_match",
    });
  });

  it("removes one receipt and keeps the rest matched", () => {
    const both = { ...tx, receipt_meta: [ACME, GLOBEX] };
    expect(removeReceipt(both, ACME.file)).toEqual({ status: "MATCHED", receipt_meta: [GLOBEX], receipt_files: [GLOBEX.file], notes: "manual_match" });
  });

  it("sends the transaction back to UNMATCHED when its last receipt goes", () => {
    expect(removeReceipt(tx, ACME.file)).toEqual(unmatch());
  });
});

describe("unmatch", () => {
  it("frees every receipt", () => {
    expect(unmatch()).toEqual({ status: "UNMATCHED", receipt_meta: [], receipt_files: [], notes: "" });
  });
});

describe("assign", () => {
  it("binds the receipt as a manual match", () => {
    expect(assign(ACME)).toEqual({ status: "MATCHED", receipt_meta: [ACME], receipt_files: [ACME.file], notes: "manual_match" });
  });
});

describe("noReceipt", () => {
  it("matches without receipts under the category", () => {
    expect(noReceipt("salary")).toEqual({ status: "MATCHED", receipt_meta: [], receipt_files: [], notes: "salary" });
  });
});

describe("forDraft", () => {
  it("strips the preview path from every receipt", () => {
    const stored = forDraft(assign(ACME));
    const { rel_path: _relPath, ...withoutPath } = ACME;
    expect(stored).toEqual({ status: "MATCHED", receipt_meta: [withoutPath], receipt_files: [ACME.file], notes: "manual_match" });
    expect("rel_path" in stored.receipt_meta[0]).toBe(false);
  });

  it("leaves the decision it was given untouched", () => {
    const decision = assign(ACME);
    forDraft(decision);
    expect(decision.receipt_meta[0].rel_path).toBe("2030/03/receipts/acme.pdf");
  });
});

describe("changedIds", () => {
  it("names decisions added, removed or replaced", () => {
    const kept = unmatch();
    const a = { "tx-1": kept, "tx-2": unmatch(), "tx-3": noReceipt("refund") };
    const b = { "tx-1": kept, "tx-2": assign(ACME), "tx-4": noReceipt("salary") };
    expect(changedIds(a, b).sort()).toEqual(["tx-2", "tx-3", "tx-4"]);
    expect(changedIds(a, a)).toEqual([]);
  });
});

