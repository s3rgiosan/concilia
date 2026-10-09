import { describe, expect, it } from "vitest";
import type { Draft } from "../lib/tauri";
import { makeReceipt, makeReviewData, makeTransaction } from "../test/fixtures";
import {
  amountMismatch,
  byAmountProximity,
  claimedFiles,
  filterCounts,
  isNoReceipt,
  mergeDraft,
  NO_RECEIPT_CATEGORIES,
  patchReceipt,
  relPaths,
  unmatchedPool,
  visibleTransactions,
} from "./effective";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME" });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: 3000 });
const INITECH = makeReceipt("initech.pdf", { vendor: "INITECH", amount_cents: 4000 });

const files = (receipts: { file: string }[]) => receipts.map((r) => r.file);

describe("isNoReceipt", () => {
  it("accepts every no-receipt category", () => {
    for (const category of NO_RECEIPT_CATEGORIES) {
      expect(isNoReceipt(category)).toBe(true);
    }
  });

  it("rejects match notes", () => {
    expect(isNoReceipt("amount_match")).toBe(false);
    expect(isNoReceipt("")).toBe(false);
  });
});

describe("relPaths", () => {
  it("maps every receipt to its preview path", () => {
    const data = makeReviewData({
      transactions: [makeTransaction("tx-1", { receipt_meta: [ACME] })],
      unmatched_receipts: [GLOBEX],
      reimbursements: [HOOLI],
    });
    expect(relPaths(data)).toEqual(
      new Map([
        [ACME.file, "2030/03/receipts/acme.pdf"],
        [GLOBEX.file, "2030/03/receipts/globex.pdf"],
        [HOOLI.file, "2030/03/receipts/hooli.pdf"],
      ]),
    );
  });

  it("skips receipts without a preview path", () => {
    const data = makeReviewData({
      unmatched_receipts: [{ ...ACME, rel_path: null }, { ...GLOBEX, rel_path: undefined }],
    });
    expect(relPaths(data).size).toBe(0);
  });
});

describe("mergeDraft", () => {
  const transactions = [
    makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME, GLOBEX], notes: "2 receipts match amount" }),
    makeTransaction("tx-2"),
  ];

  it("leaves transactions without a decision as they are", () => {
    const merged = mergeDraft(transactions, {});
    expect(merged[0]).toBe(transactions[0]);
    expect(merged[1]).toBe(transactions[1]);
  });

  it("lays each decision over its transaction", () => {
    const { rel_path: _relPath, ...stored } = ACME;
    const draft: Draft = {
      "tx-1": { status: "MATCHED", receipt_meta: [stored], receipt_files: [ACME.file], notes: "amount_match" },
    };
    const merged = mergeDraft(transactions, draft);
    expect(merged[0]).toMatchObject({ id: "tx-1", description: "ACME CORP", status: "MATCHED", notes: "amount_match" });
    expect(merged[0].receipt_files).toEqual([ACME.file]);
    expect(merged[1]).toBe(transactions[1]);
  });

  it("gives receipts in a decision their preview path back", () => {
    const { rel_path: _relPath, ...stored } = ACME;
    const draft: Draft = { "tx-2": { status: "MATCHED", receipt_meta: [stored], receipt_files: [ACME.file], notes: "manual_match" } };
    const merged = mergeDraft(transactions, draft, new Map([[ACME.file, "2030/03/receipts/acme.pdf"]]));
    expect(merged[1].receipt_meta[0].rel_path).toBe("2030/03/receipts/acme.pdf");
  });

  it("keeps a preview path the decision already has", () => {
    const draft: Draft = { "tx-2": { status: "MATCHED", receipt_meta: [ACME], receipt_files: [ACME.file], notes: "manual_match" } };
    const merged = mergeDraft(transactions, draft, new Map([[ACME.file, "elsewhere/acme.pdf"]]));
    expect(merged[1].receipt_meta[0].rel_path).toBe("2030/03/receipts/acme.pdf");
  });

  it("leaves the preview path empty when it is unknown", () => {
    const { rel_path: _relPath, ...stored } = ACME;
    const draft: Draft = { "tx-2": { status: "MATCHED", receipt_meta: [stored], receipt_files: [ACME.file], notes: "manual_match" } };
    expect(mergeDraft(transactions, draft)[1].receipt_meta[0].rel_path).toBeNull();
  });

  it("keeps the transaction's receipts when the decision has none", () => {
    const merged = mergeDraft(transactions, { "tx-1": { notes: "amount_match" } });
    expect(files(merged[0].receipt_meta)).toEqual([ACME.file, GLOBEX.file]);
  });

  it("handles a decision that clears the receipt list", () => {
    const tx = { ...makeTransaction("tx-3"), receipt_meta: undefined } as unknown as ReturnType<typeof makeTransaction>;
    const merged = mergeDraft([tx], { "tx-3": { status: "MATCHED", notes: "salary" } });
    expect(merged[0].receipt_meta).toEqual([]);
  });
});

describe("claimedFiles", () => {
  it("claims the receipts of MATCHED transactions", () => {
    const merged = [
      makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME], notes: "amount_match" }),
      makeTransaction("tx-2", { status: "MATCHED", receipt_meta: [GLOBEX, HOOLI], notes: "manual_match" }),
    ];
    expect(claimedFiles(merged)).toEqual(new Set([ACME.file, GLOBEX.file, HOOLI.file]));
  });

  it("claims nothing for REVIEW or UNMATCHED transactions", () => {
    const merged = [
      makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME] }),
      makeTransaction("tx-2", { status: "UNMATCHED", receipt_meta: [GLOBEX] }),
    ];
    expect(claimedFiles(merged).size).toBe(0);
  });

  it("claims nothing for no-receipt categories", () => {
    const merged = NO_RECEIPT_CATEGORIES.map((notes, i) => makeTransaction(`tx-${i}`, { status: "MATCHED", receipt_meta: [ACME], notes }));
    expect(claimedFiles(merged).size).toBe(0);
  });
});

describe("unmatchedPool", () => {
  it("holds the matcher's unmatched receipts", () => {
    const data = makeReviewData({ unmatched_receipts: [ACME, GLOBEX] });
    expect(files(unmatchedPool(data, []))).toEqual([ACME.file, GLOBEX.file]);
  });

  it("adds receipts no reviewed transaction references any more", () => {
    const original = makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME, GLOBEX] });
    const data = makeReviewData({ transactions: [original], unmatched_receipts: [HOOLI] });
    const merged = mergeDraft(data.transactions, {
      "tx-1": { status: "MATCHED", receipt_meta: [ACME], receipt_files: [ACME.file], notes: "amount_match" },
    });
    expect(files(unmatchedPool(data, merged))).toEqual([HOOLI.file, GLOBEX.file]);
  });

  it("keeps receipts a REVIEW transaction still references out of the pool", () => {
    const data = makeReviewData({
      transactions: [makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME] })],
    });
    expect(unmatchedPool(data, data.transactions)).toEqual([]);
  });

  it("removes claimed receipts", () => {
    const data = makeReviewData({
      transactions: [makeTransaction("tx-1"), makeTransaction("tx-2", { status: "REVIEW", receipt_meta: [INITECH] })],
      unmatched_receipts: [ACME, GLOBEX],
    });
    const merged = mergeDraft(data.transactions, {
      "tx-1": { status: "MATCHED", receipt_meta: [ACME], receipt_files: [ACME.file], notes: "manual_match" },
      "tx-2": { status: "UNMATCHED", receipt_meta: [], receipt_files: [], notes: "" },
    });
    expect(files(unmatchedPool(data, merged))).toEqual([GLOBEX.file, INITECH.file]);
  });
});

describe("byAmountProximity", () => {
  it("orders receipts by distance to the amount, those without an amount last", () => {
    const unknown = makeReceipt("unknown.pdf", { amount_cents: null });
    const sorted = byAmountProximity([unknown, INITECH, ACME, HOOLI, GLOBEX], 2900);
    expect(files(sorted)).toEqual([HOOLI.file, GLOBEX.file, INITECH.file, ACME.file, unknown.file]);
  });

  it("leaves the pool untouched", () => {
    const pool = [INITECH, ACME];
    byAmountProximity(pool, 1000);
    expect(pool).toEqual([INITECH, ACME]);
  });
});

describe("amountMismatch", () => {
  it("flags any difference for euro receipts", () => {
    expect(amountMismatch(makeReceipt("a.pdf", { amount_cents: 1000 }), 1000)).toBe(false);
    expect(amountMismatch(makeReceipt("a.pdf", { amount_cents: 1001 }), 1000)).toBe(true);
    expect(amountMismatch(makeReceipt("a.pdf", { amount_cents: 999 }), 1000)).toBe(true);
  });

  it("treats a receipt without a currency as euros", () => {
    expect(amountMismatch(makeReceipt("a.pdf", { amount_cents: 1001, currency: null }), 1000)).toBe(true);
  });

  it("allows 10% either way for other currencies", () => {
    const usd = (amount: number) => makeReceipt("a.pdf", { amount_cents: amount, currency: "USD" });
    expect(amountMismatch(usd(1100), 1000)).toBe(false);
    expect(amountMismatch(usd(900), 1000)).toBe(false);
    expect(amountMismatch(usd(1101), 1000)).toBe(true);
    expect(amountMismatch(usd(899), 1000)).toBe(true);
  });

  it("never flags a receipt without an amount", () => {
    expect(amountMismatch(makeReceipt("a.pdf", { amount_cents: null }), 1000)).toBe(false);
  });
});

describe("filterCounts", () => {
  it("counts transactions by status", () => {
    const merged = [
      makeTransaction("tx-1", { status: "MATCHED" }),
      makeTransaction("tx-2", { status: "REVIEW" }),
      makeTransaction("tx-3", { status: "REVIEW" }),
      makeTransaction("tx-4", { status: "UNMATCHED" }),
    ];
    expect(filterCounts(merged)).toEqual({ all: 4, review: 2, unmatched: 1, matched: 1 });
  });

  it("counts nothing for no transactions", () => {
    expect(filterCounts([])).toEqual({ all: 0, review: 0, unmatched: 0, matched: 0 });
  });
});

describe("visibleTransactions", () => {
  const merged = [
    makeTransaction("tx-3", { date: "2030-03-10", description: "HOOLI CLOUD", status: "MATCHED" }),
    makeTransaction("tx-2", { date: "2030-03-05", description: "GLOBEX SHOP", status: "REVIEW" }),
    makeTransaction("tx-1", { date: "2030-03-05", description: "ACME CORP", status: "UNMATCHED" }),
    makeTransaction("tx-4", { date: "2030-03-01", description: "INITECH", status: "MATCHED" }),
  ];
  const ids = (txs: { id: string }[]) => txs.map((tx) => tx.id);

  it("shows every transaction by date, then ID", () => {
    expect(ids(visibleTransactions(merged, "all", ""))).toEqual(["tx-4", "tx-1", "tx-2", "tx-3"]);
  });

  it("filters by status", () => {
    expect(ids(visibleTransactions(merged, "matched", ""))).toEqual(["tx-4", "tx-3"]);
    expect(ids(visibleTransactions(merged, "review", ""))).toEqual(["tx-2"]);
    expect(ids(visibleTransactions(merged, "unmatched", ""))).toEqual(["tx-1"]);
  });

  it("searches descriptions, ignoring case and surrounding spaces", () => {
    expect(ids(visibleTransactions(merged, "all", "  hooli "))).toEqual(["tx-3"]);
    expect(ids(visibleTransactions(merged, "all", "O"))).toEqual(["tx-1", "tx-2", "tx-3"]);
  });

  it("combines the filter and the search", () => {
    expect(ids(visibleTransactions(merged, "matched", "initech"))).toEqual(["tx-4"]);
    expect(visibleTransactions(merged, "review", "initech")).toEqual([]);
  });

  it("leaves the list untouched", () => {
    const copy = [...merged];
    visibleTransactions(merged, "all", "");
    expect(merged).toEqual(copy);
  });
});

describe("patchReceipt", () => {
  const data = makeReviewData({
    transactions: [makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME, GLOBEX] })],
    unmatched_receipts: [ACME, HOOLI],
    reimbursements: [ACME, INITECH],
  });

  it("replaces the receipt wherever it appears", () => {
    const rescanned = { ...ACME, amount_cents: 1500, vendor: "ACME LTD" };
    const patched = patchReceipt(data, rescanned);
    expect(patched.transactions[0].receipt_meta).toEqual([rescanned, GLOBEX]);
    expect(patched.unmatched_receipts).toEqual([rescanned, HOOLI]);
    expect(patched.reimbursements).toEqual([rescanned, INITECH]);
  });

  it("keeps the preview path when the new metadata lacks one", () => {
    const { rel_path: _relPath, ...rescanned } = { ...ACME, amount_cents: 1500 };
    const patched = patchReceipt(data, rescanned);
    expect(patched.unmatched_receipts[0]).toEqual({ ...rescanned, rel_path: ACME.rel_path });
  });

  it("uses the new preview path when there is one", () => {
    const patched = patchReceipt(data, { ...ACME, rel_path: "moved/acme.pdf" });
    expect(patched.reimbursements[0].rel_path).toBe("moved/acme.pdf");
  });

  it("leaves other receipts alone", () => {
    const patched = patchReceipt(data, makeReceipt("other.pdf"));
    expect(patched).toEqual(data);
  });
});
