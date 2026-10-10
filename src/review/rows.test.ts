import { describe, expect, it } from "vitest";
import { makeReceipt, makeTransaction } from "../test/fixtures";
import { buildRows, findPending, initialSelection, isPending, reimbursementId, resolveSelection, rowReceipts, type ListRow } from "./rows";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME", amount_cents: 1000 });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: 3000 });
const TAXI = makeReceipt("taxi.pdf", { vendor: "INITECH CABS" });

const MATCHED = makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME] });
const REVIEW = makeTransaction("tx-2", { status: "REVIEW", amount_cents: -2000, receipt_meta: [ACME, GLOBEX] });
const UNMATCHED = makeTransaction("tx-3", { status: "UNMATCHED", amount_cents: -2900 });
const INCOME = makeTransaction("tx-4", { status: "UNMATCHED", amount_cents: 50000 });

const ROWS = buildRows([MATCHED, REVIEW, UNMATCHED], [TAXI]);
const ids = (rows: (ListRow | null)[]) => rows.map((r) => r?.id ?? null);

describe("buildRows", () => {
  it("lists transactions, then reimbursements", () => {
    expect(ids(ROWS)).toEqual(["tx-1", "tx-2", "tx-3", "reimbursement:/receipts/2030/03/receipts/taxi.pdf"]);
    expect(reimbursementId(TAXI)).toBe(ROWS[3].id);
    expect(ROWS.map(isPending)).toEqual([false, true, true, false]);
  });
});

describe("initialSelection", () => {
  it("picks the first row that needs a decision", () => {
    expect(initialSelection(ROWS)?.id).toBe("tx-2");
  });

  it("falls back to the first row, or none", () => {
    expect(initialSelection(buildRows([MATCHED], [TAXI]))?.id).toBe("tx-1");
    expect(initialSelection([])).toBeNull();
  });
});

describe("resolveSelection", () => {
  it("keeps a listed selection", () => {
    expect(resolveSelection(ROWS, "tx-3")?.id).toBe("tx-3");
  });

  it("takes the row at the fallback index when the selection left the list", () => {
    expect(resolveSelection(ROWS, "tx-9", 1)?.id).toBe("tx-2");
    expect(resolveSelection(ROWS, "tx-9", 10)?.id).toBe(ROWS[3].id);
    expect(resolveSelection(ROWS, "tx-9", -2)?.id).toBe("tx-1");
    expect(resolveSelection(ROWS, null)?.id).toBe("tx-1");
  });

  it("selects nothing in an empty list", () => {
    expect(resolveSelection([], "tx-1")).toBeNull();
  });

  it("prefers the next row needing a decision, then the one before, when asked", () => {
    expect(resolveSelection(ROWS, "tx-9", 0, true)?.id).toBe("tx-2");
    expect(resolveSelection(ROWS, "tx-9", 3, true)?.id).toBe("tx-3");
    expect(resolveSelection(buildRows([MATCHED], [TAXI]), "tx-9", 1, true)?.id).toBe(ROWS[3].id);
  });
});

describe("findPending", () => {
  it("finds the next and previous row needing a decision", () => {
    expect(findPending(ROWS, 0, 1)).toBe(1);
    expect(findPending(ROWS, 1, 1)).toBe(2);
    expect(findPending(ROWS, 2, 1)).toBe(-1);
    expect(findPending(ROWS, 3, -1)).toBe(2);
    expect(findPending(ROWS, 1, -1)).toBe(-1);
  });

  it("starts from either end", () => {
    expect(findPending(ROWS, -1, 1)).toBe(1);
    expect(findPending(ROWS, ROWS.length, -1)).toBe(2);
  });
});

describe("rowReceipts", () => {
  const row = (tx: typeof MATCHED): ListRow => ({ kind: "transaction", id: tx.id, tx });

  it("lists a REVIEW transaction's open candidates", () => {
    expect(rowReceipts(row(REVIEW), [], new Set([ACME.file]))).toEqual([GLOBEX]);
  });

  it("lists the pool receipts that fit an UNMATCHED transaction, closest first", () => {
    expect(rowReceipts(row(UNMATCHED), [ACME, HOOLI, GLOBEX], new Set())).toEqual([HOOLI, GLOBEX, ACME]);
    expect(rowReceipts(row(INCOME), [ACME, HOOLI], new Set())).toEqual([]);
  });

  it("lists a MATCHED transaction's receipts and a reimbursement itself", () => {
    expect(rowReceipts(row(MATCHED), [GLOBEX], new Set([ACME.file]))).toEqual([ACME]);
    expect(rowReceipts(ROWS[3], [GLOBEX], new Set())).toEqual([TAXI]);
    expect(rowReceipts(null, [GLOBEX], new Set())).toEqual([]);
  });
});
