// The review state the user sees: the match result with pending decisions applied.

import { fileName } from "../lib/paths";
import type { Draft, ReceiptMeta, ReviewData, Status, Transaction } from "../lib/tauri";

/** Notes of transactions the user marked as needing no receipt. */
export const NO_RECEIPT_CATEGORIES = ["bank_fee", "salary", "transfer", "refund", "no_receipt"] as const;
export type NoReceiptCategory = (typeof NO_RECEIPT_CATEGORIES)[number];

/** The categories money coming in most likely needs no receipt for. */
const CREDIT_CATEGORIES: readonly NoReceiptCategory[] = ["transfer", "salary", "refund"];

/**
 * The No Receipt Needed choices for a transaction, in menu order: money coming in lists its likely
 * categories first and the rest after a separator; money going out lists every category.
 */
export function noReceiptChoices(tx: Transaction): (NoReceiptCategory | "separator")[] {
  if (tx.amount_cents <= 0) {
    return [...NO_RECEIPT_CATEGORIES];
  }
  const others = NO_RECEIPT_CATEGORIES.filter((category) => !CREDIT_CATEGORIES.includes(category));
  return [...CREDIT_CATEGORIES, "separator", ...others];
}

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
 * Pool receipts that fit a transaction, closest amount first. Receipts carry the amount paid, so
 * a positive receipt fits money going out and a negative one (a credit note) money coming in.
 * Receipts without an amount are offered for money going out, where nearly every receipt belongs.
 */
export function assignableReceipts(pool: ReceiptMeta[], tx: Pick<Transaction, "amount_cents" | "abs_cents">): ReceiptMeta[] {
  const outgoing = tx.amount_cents < 0;
  const fits = (r: ReceiptMeta) => (r.amount_cents === null ? outgoing : (r.amount_cents >= 0) === outgoing);
  return byAmountProximity(pool.filter(fits), tx.abs_cents);
}

/** A REVIEW transaction's candidates that no MATCHED transaction holds. */
export function openCandidates(tx: Transaction, claimed: Set<string>): ReceiptMeta[] {
  return tx.receipt_meta.filter((m) => !claimed.has(m.file));
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

export type Mismatch = { kind: "amount"; cents: number } | { kind: "fx" };

/**
 * How a receipt's amount differs from its transaction's: by how many cents for euro receipts, or
 * by more than the 10% allowed for other currencies. Null when it fits.
 */
export function mismatch(receipt: ReceiptMeta, txAbsCents: number): Mismatch | null {
  if (!amountMismatch(receipt, txAbsCents) || receipt.amount_cents === null) {
    return null;
  }
  if (receipt.currency && receipt.currency !== "EUR") {
    return { kind: "fx" };
  }
  return { kind: "amount", cents: Math.abs(receipt.amount_cents - txAbsCents) };
}

/** The list filters: transactions still to decide, matched ones, and every transaction. */
export const FILTERS = ["pending", "matched", "all"] as const;
export type Filter = (typeof FILTERS)[number];

/** Whether a transaction still waits for a decision: REVIEW or UNMATCHED. */
export function needsDecision(tx: Pick<Transaction, "status">): boolean {
  return tx.status !== "MATCHED";
}

export function pendingCount(merged: Transaction[]): number {
  return merged.filter(needsDecision).length;
}

export function filterCounts(merged: Transaction[]): Record<Filter, number> {
  const pending = pendingCount(merged);
  return { pending, matched: merged.length - pending, all: merged.length };
}

/** Whether a transaction shows under a filter. */
function inFilter(tx: Transaction, filter: Filter): boolean {
  switch (filter) {
    case "pending":
      return needsDecision(tx);
    case "matched":
      return !needsDecision(tx);
    case "all":
    default:
      return true;
  }
}

/** Transactions shown for a filter and search text, by date, then ID. */
export function visibleTransactions(merged: Transaction[], filter: Filter, search: string): Transaction[] {
  const needle = search.trim().toLowerCase();
  return merged
    .filter((tx) => inFilter(tx, filter))
    .filter((tx) => !needle || tx.description.toLowerCase().includes(needle))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** Reimbursements shown for a filter and search text: only under All, searched by vendor and file name. */
export function visibleReimbursements(receipts: ReceiptMeta[], filter: Filter, search: string): ReceiptMeta[] {
  if (filter !== "all") {
    return [];
  }
  const needle = search.trim().toLowerCase();
  return receipts.filter((r) => !needle || `${r.vendor ?? ""} ${fileName(r.file)}`.toLowerCase().includes(needle));
}

export interface FinalizeCounts {
  matched: number;
  review: number;
  unmatched: number;
  total: number;
}

const RANK: Record<Status, number> = { MATCHED: 0, REVIEW: 1, UNMATCHED: 2 };

/**
 * Where Finalize sorts the receipts: each file goes to the folder of the strongest status that
 * references it (MATCHED, then REVIEW, then UNMATCHED), and every pool receipt goes to _unmatched.
 * The backend's `finalize::plan` sorts the same way.
 */
export function finalizeCounts(data: Pick<ReviewData, "transactions" | "unmatched_receipts">, merged: Transaction[]): FinalizeCounts {
  const best = new Map<string, Status>();
  const note = (file: string, status: Status) => {
    const current = best.get(file);
    if (current === undefined || RANK[status] < RANK[current]) {
      best.set(file, status);
    }
  };
  for (const tx of merged) {
    for (const meta of tx.receipt_meta) {
      note(meta.file, tx.status);
    }
  }
  for (const receipt of unmatchedPool(data, merged)) {
    note(receipt.file, "UNMATCHED");
  }
  const counts: FinalizeCounts = { matched: 0, review: 0, unmatched: 0, total: best.size };
  for (const status of best.values()) {
    counts[status.toLowerCase() as Lowercase<Status>] += 1;
  }
  return counts;
}

/** Replaces a receipt's metadata wherever it appears, after a rescan. */
export function patchReceipt(data: ReviewData, meta: ReceiptMeta): ReviewData {
  const patch = (m: ReceiptMeta) => (m.file === meta.file ? { ...meta, rel_path: meta.rel_path ?? m.rel_path } : m);
  return {
    ...data,
    transactions: data.transactions.map((tx) => ({ ...tx, receipt_meta: tx.receipt_meta.map(patch) })),
    unmatched_receipts: data.unmatched_receipts.map(patch),
    reimbursements: data.reimbursements.map(patch),
  };
}
