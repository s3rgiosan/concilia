// The review state the user sees: the match result with pending decisions applied.

import type { Draft, ReceiptMeta, ReviewData, Status, Transaction } from "../lib/tauri";

/** Notes of transactions the user marked as needing no receipt. */
export const NO_RECEIPT_CATEGORIES = ["bank_fee", "salary", "transfer", "refund", "no_receipt"] as const;
export type NoReceiptCategory = (typeof NO_RECEIPT_CATEGORIES)[number];

export function isNoReceipt(notes: string): notes is NoReceiptCategory {
  return (NO_RECEIPT_CATEGORIES as readonly string[]).includes(notes);
}

/** Every receipt's path relative to the receipts root, by file, for previews. */
export function relPaths(data: ReviewData): Map<string, string> {
  const paths = new Map<string, string>();
  const all = [...data.transactions.flatMap((tx) => tx.receipt_meta), ...data.unmatched_receipts, ...data.reimbursements];
  for (const meta of all) {
    if (meta.rel_path) {
      paths.set(meta.file, meta.rel_path);
    }
  }
  return paths;
}

/**
 * Each transaction with its pending decision laid over it. Receipts in a decision get their
 * preview path back from `paths`, since the draft stores none.
 */
export function mergeDraft(transactions: Transaction[], draft: Draft, paths: Map<string, string> = new Map()): Transaction[] {
  return transactions.map((tx) => {
    const change = draft[tx.id];
    if (!change) {
      return tx;
    }
    const merged = { ...tx, ...change };
    return {
      ...merged,
      receipt_meta: (merged.receipt_meta ?? []).map((m) => (m.rel_path ? m : { ...m, rel_path: paths.get(m.file) ?? null })),
    };
  });
}

/** Receipt files bound to a MATCHED transaction, which no other transaction can use. */
export function claimedFiles(merged: Transaction[]): Set<string> {
  const claimed = new Set<string>();
  for (const tx of merged) {
    if (tx.status === "MATCHED" && !isNoReceipt(tx.notes)) {
      for (const meta of tx.receipt_meta) {
        claimed.add(meta.file);
      }
    }
  }
  return claimed;
}

/**
 * Receipts free for assignment: the matcher's unmatched receipts, plus every receipt of the
 * original transactions that no reviewed transaction references any more, minus every claimed
 * receipt. The backend's `review::effective_unmatched` computes the same list for Finalize.
 */
export function unmatchedPool(data: Pick<ReviewData, "transactions" | "unmatched_receipts">, merged: Transaction[]): ReceiptMeta[] {
  const pool = new Map<string, ReceiptMeta>();
  for (const receipt of data.unmatched_receipts) {
    pool.set(receipt.file, receipt);
  }
  const referenced = new Set<string>();
  for (const tx of merged) {
    for (const meta of tx.receipt_meta) {
      referenced.add(meta.file);
    }
  }
  for (const tx of data.transactions) {
    for (const meta of tx.receipt_meta) {
      if (!referenced.has(meta.file)) {
        pool.set(meta.file, meta);
      }
    }
  }
  for (const file of claimedFiles(merged)) {
    pool.delete(file);
  }
  return [...pool.values()];
}

/** The pool ordered by how close each amount is to `absCents`; receipts without an amount last. */
export function byAmountProximity(pool: ReceiptMeta[], absCents: number): ReceiptMeta[] {
  const distance = (r: ReceiptMeta) => (r.amount_cents === null ? Number.POSITIVE_INFINITY : Math.abs(r.amount_cents - absCents));
  return [...pool].sort((a, b) => distance(a) - distance(b));
}

/**
 * Whether a receipt's amount looks wrong for its transaction: any difference for euro receipts,
 * more than 10% for other currencies, which the bank converts.
 */
export function amountMismatch(receipt: ReceiptMeta, txAbsCents: number): boolean {
  if (receipt.amount_cents === null) {
    return false;
  }
  if (receipt.currency && receipt.currency !== "EUR") {
    return Math.abs(receipt.amount_cents - txAbsCents) > txAbsCents * 0.1;
  }
  return receipt.amount_cents !== txAbsCents;
}

export type Filter = "all" | "review" | "unmatched" | "matched";

export function filterCounts(merged: Transaction[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: merged.length, review: 0, unmatched: 0, matched: 0 };
  for (const tx of merged) {
    counts[tx.status.toLowerCase() as Lowercase<Status>] += 1;
  }
  return counts;
}

/** Transactions shown for a filter and search text, by date, then ID. */
export function visibleTransactions(merged: Transaction[], filter: Filter, search: string): Transaction[] {
  const needle = search.trim().toLowerCase();
  return merged
    .filter((tx) => filter === "all" || tx.status.toLowerCase() === filter)
    .filter((tx) => !needle || tx.description.toLowerCase().includes(needle))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Replaces a receipt's metadata wherever it appears, after a rescan. */
export function patchReceipt(data: ReviewData, meta: ReceiptMeta): ReviewData {
  const patch = (m: ReceiptMeta) => (m.file === meta.file ? { ...meta, rel_path: meta.rel_path ?? m.rel_path } : m);
  return {
    transactions: data.transactions.map((tx) => ({ ...tx, receipt_meta: tx.receipt_meta.map(patch) })),
    unmatched_receipts: data.unmatched_receipts.map(patch),
    reimbursements: data.reimbursements.map(patch),
  };
}
