import { describe, expect, it } from "vitest";
import type { Draft } from "../lib/tauri";
import { makeReceipt, makeReviewData, makeTransaction } from "../test/fixtures";
import {
  addableReceipts,
  amountMismatch,
  assignableReceipts,
  byAmountProximity,
  claimedFiles,
  filterCounts,
  finalizeCounts,
  isNoReceipt,
  mergeDraft,
  mismatch,
  needsDecision,
  openCandidates,
  patchReceipt,
  pendingCount,
  relPaths,
  receiptsTotal,
  totalMismatch,
  unmatchedPool,
  visibleReimbursements,
  visibleTransactions,
} from "./effective";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME" });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: 3000 });
const INITECH = makeReceipt("initech.pdf", { vendor: "INITECH", amount_cents: 4000 });

const files = (receipts: { file: string }[]) => receipts.map((r) => r.file);

const REASON_IDS = ["bank_fee", "salary", "transfer", "refund", "no_receipt", "reason:lunch"];

describe("isNoReceipt", () => {
  it("accepts shipped and custom reason ids, also of deleted reasons", () => {
    for (const id of REASON_IDS) {
      expect(isNoReceipt(id)).toBe(true);
    }
    expect(isNoReceipt("reason:")).toBe(false);
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
    const merged = REASON_IDS.map((notes, i) => makeTransaction(`tx-${i}`, { status: "MATCHED", receipt_meta: [ACME], notes }));
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
    expect(filterCounts(merged)).toEqual({ pending: 3, matched: 1, all: 4 });
  });

  it("counts nothing for no transactions", () => {
    expect(filterCounts([])).toEqual({ pending: 0, matched: 0, all: 0 });
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

  it("filters the transactions still to decide, REVIEW and UNMATCHED, and the matched ones", () => {
    expect(ids(visibleTransactions(merged, "pending", ""))).toEqual(["tx-1", "tx-2"]);
    expect(ids(visibleTransactions(merged, "matched", ""))).toEqual(["tx-4", "tx-3"]);
  });

  it("searches descriptions, ignoring case and surrounding spaces", () => {
    expect(ids(visibleTransactions(merged, "all", "  hooli "))).toEqual(["tx-3"]);
    expect(ids(visibleTransactions(merged, "all", "O"))).toEqual(["tx-1", "tx-2", "tx-3"]);
  });

  it("combines the filter and the search", () => {
    expect(ids(visibleTransactions(merged, "matched", "initech"))).toEqual(["tx-4"]);
    expect(visibleTransactions(merged, "pending", "initech")).toEqual([]);
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

  it("keeps the objects that do not hold the receipt", () => {
    const other = makeTransaction("tx-2", { status: "MATCHED", receipt_meta: [HOOLI] });
    const holding = makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME] });
    const patched = patchReceipt(makeReviewData({ transactions: [holding, other], unmatched_receipts: [INITECH] }), { ...ACME, amount_cents: 1500 });
    expect(patched.transactions[0]).not.toBe(holding);
    expect(patched.transactions[1]).toBe(other);
    expect(patched.unmatched_receipts).toEqual([INITECH]);
  });

  it("keeps the statements the month holds", () => {
    const statements = [{ file: "statement.pdf", bank: "cgd" as const, transactions: 2, added_at: "2030-03-01T00:00:00Z" }];
    const patched = patchReceipt({ ...data, statements }, { ...ACME, amount_cents: 1500 });
    expect(patched.statements).toEqual(statements);
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

describe("assignableReceipts", () => {
  const unread = makeReceipt("scan.pdf", { amount_cents: null });
  const credit = makeReceipt("credit.pdf", { vendor: "INITECH", amount_cents: -1500 });

  it("offers positive receipts and unread ones to money going out, closest first", () => {
    const tx = makeTransaction("tx-1", { amount_cents: -2900 });
    expect(files(assignableReceipts([unread, ACME, HOOLI, credit, GLOBEX], tx))).toEqual([HOOLI.file, GLOBEX.file, ACME.file, unread.file]);
  });

  it("offers nothing but credit notes to money coming in", () => {
    const tx = makeTransaction("tx-1", { amount_cents: 50000 });
    expect(assignableReceipts([unread, ACME, GLOBEX], tx)).toEqual([]);
    expect(files(assignableReceipts([ACME, credit], tx))).toEqual([credit.file]);
  });
});

describe("addableReceipts", () => {
  it("orders the pool by the amount the transaction's receipts leave uncovered", () => {
    const small = makeReceipt("small.pdf", { amount_cents: 600 });
    const tx = makeTransaction("tx-1", { amount_cents: -1500, status: "MATCHED", receipt_meta: [ACME] });
    expect(files(addableReceipts([GLOBEX, small], tx))).toEqual([small.file, GLOBEX.file]);
  });
});

describe("totalMismatch", () => {
  const five = makeReceipt("five.pdf", { amount_cents: 500 });

  it("is null when the euro receipts add up to the amount", () => {
    expect(totalMismatch([five, five], 1000)).toBeNull();
  });

  it("gives the difference in cents otherwise", () => {
    expect(totalMismatch([five, five], 1200)).toBe(200);
  });

  it("adds credit notes by size, as they fit money coming in", () => {
    const credit = makeReceipt("credit.pdf", { amount_cents: -500 });
    expect(receiptsTotal([credit, credit])).toBe(1000);
    expect(totalMismatch([credit, credit], 1000)).toBeNull();
  });

  it("is null when a receipt has no amount or another currency", () => {
    expect(receiptsTotal([five, makeReceipt("usd.pdf", { currency: "USD", amount_cents: 500 })])).toBeNull();
    expect(totalMismatch([five, makeReceipt("x.pdf", { amount_cents: null })], 1200)).toBeNull();
    expect(totalMismatch([five, makeReceipt("usd.pdf", { currency: "USD", amount_cents: 500 })], 1200)).toBeNull();
  });
});

describe("openCandidates", () => {
  it("leaves out candidates a MATCHED transaction holds", () => {
    const tx = makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME, GLOBEX] });
    expect(files(openCandidates(tx, new Set([ACME.file])))).toEqual([GLOBEX.file]);
    expect(files(openCandidates(tx, new Set()))).toEqual([ACME.file, GLOBEX.file]);
  });
});

describe("mismatch", () => {
  it("is null when the amount fits", () => {
    expect(mismatch(ACME, 1000)).toBeNull();
    expect(mismatch(makeReceipt("usd.pdf", { currency: "USD", amount_cents: 1050 }), 1000)).toBeNull();
    expect(mismatch(makeReceipt("scan.pdf", { amount_cents: null }), 1000)).toBeNull();
  });

  it("gives the difference of a euro receipt", () => {
    expect(mismatch(ACME, 2500)).toEqual({ kind: "amount", cents: 1500 });
    expect(mismatch(GLOBEX, 500)).toEqual({ kind: "amount", cents: 1500 });
  });

  it("flags a foreign receipt beyond the tolerance", () => {
    expect(mismatch(makeReceipt("usd.pdf", { currency: "USD", amount_cents: 2000 }), 1000)).toEqual({ kind: "fx" });
  });
});

describe("needsDecision and pendingCount", () => {
  it("counts REVIEW and UNMATCHED transactions", () => {
    const merged = [
      makeTransaction("tx-1", { status: "MATCHED" }),
      makeTransaction("tx-2", { status: "REVIEW" }),
      makeTransaction("tx-3", { status: "UNMATCHED" }),
    ];
    expect(merged.map(needsDecision)).toEqual([false, true, true]);
    expect(pendingCount(merged)).toBe(2);
    expect(pendingCount([])).toBe(0);
  });
});

describe("visibleReimbursements", () => {
  const taxi = makeReceipt("taxi.pdf", { vendor: "HOOLI CABS" });
  const train = makeReceipt("rail-ticket.pdf", { vendor: null });

  it("shows every reimbursement under All", () => {
    expect(visibleReimbursements([taxi, train], "all", "")).toEqual([taxi, train]);
  });

  it("hides them under a status filter", () => {
    expect(visibleReimbursements([taxi, train], "pending", "")).toEqual([]);
    expect(visibleReimbursements([taxi, train], "matched", "")).toEqual([]);
  });

  it("searches vendor and file name", () => {
    expect(visibleReimbursements([taxi, train], "all", " cabs ")).toEqual([taxi]);
    expect(visibleReimbursements([taxi, train], "all", "RAIL")).toEqual([train]);
    expect(visibleReimbursements([taxi, train], "all", "receipts")).toEqual([]);
  });
});

describe("finalizeCounts", () => {
  it("sorts each receipt into the folder of its strongest status", () => {
    const transactions = [
      makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME] }),
      makeTransaction("tx-2", { status: "REVIEW", receipt_meta: [ACME, GLOBEX] }),
      makeTransaction("tx-3", { status: "UNMATCHED" }),
    ];
    const data = makeReviewData({ transactions, unmatched_receipts: [HOOLI, INITECH] });
    expect(finalizeCounts(data, transactions)).toEqual({ matched: 1, review: 1, unmatched: 2, total: 4 });
  });

  it("follows pending decisions", () => {
    const transactions = [makeTransaction("tx-2", { status: "REVIEW", receipt_meta: [ACME, GLOBEX] })];
    const data = makeReviewData({ transactions, unmatched_receipts: [HOOLI] });
    const draft: Draft = { "tx-2": { status: "MATCHED", receipt_meta: [ACME], receipt_files: [ACME.file], notes: "amount_match" } };
    // GLOBEX was left out of the confirmed match, so it returns to the pool.
    expect(finalizeCounts(data, mergeDraft(transactions, draft))).toEqual({ matched: 1, review: 0, unmatched: 2, total: 3 });
  });

  it("counts nothing for an empty month", () => {
    expect(finalizeCounts(makeReviewData(), [])).toEqual({ matched: 0, review: 0, unmatched: 0, total: 0 });
  });
});
