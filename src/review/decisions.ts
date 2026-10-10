// Review decisions, as the transaction fields each one overrides.

import type { Draft, ReceiptMeta, Transaction } from "../lib/tauri";
import type { NoReceiptCategory } from "./effective";

export type Decision = Pick<Transaction, "status" | "receipt_meta" | "receipt_files" | "notes">;

/** Confirms a match: with one candidate when given, otherwise with all of them. */
export function confirm(tx: Transaction, receipt?: ReceiptMeta): Decision {
  const meta = receipt ? [receipt] : tx.receipt_meta;
  return { status: "MATCHED", receipt_meta: meta, receipt_files: meta.map((m) => m.file), notes: tx.notes || "amount_match" };
}

/** Sends a transaction back to UNMATCHED, freeing its receipts. Rejecting and disputing both do this. */
export function unmatch(): Decision {
  return { status: "UNMATCHED", receipt_meta: [], receipt_files: [], notes: "" };
}

/** Binds a receipt from the unmatched pool. */
export function assign(receipt: ReceiptMeta): Decision {
  return { status: "MATCHED", receipt_meta: [receipt], receipt_files: [receipt.file], notes: "manual_match" };
}

/** Marks a transaction as needing no receipt. */
export function noReceipt(category: NoReceiptCategory): Decision {
  return { status: "MATCHED", receipt_meta: [], receipt_files: [], notes: category };
}

/** A decision as stored in the draft, without display-only fields. */
export function forDraft(decision: Decision): Decision {
  return {
    ...decision,
    receipt_meta: decision.receipt_meta.map(({ rel_path: _relPath, ...meta }) => meta),
  };
}

/** Replaces a receipt's stored copy in every decision that holds it, after a rescan. */
export function patchDraftReceipt(draft: Draft, meta: ReceiptMeta): { draft: Draft; changed: boolean } {
  const { rel_path: _relPath, ...stored } = meta;
  let changed = false;
  const next: Draft = {};
  for (const [id, decision] of Object.entries(draft)) {
    const held = decision.receipt_meta?.some((m) => m.file === meta.file);
    if (held && decision.receipt_meta) {
      changed = true;
      next[id] = { ...decision, receipt_meta: decision.receipt_meta.map((m) => (m.file === meta.file ? stored : m)) };
    } else {
      next[id] = decision;
    }
  }
  return { draft: changed ? next : draft, changed };
}

/** IDs of the transactions whose decision differs between two drafts. */
export function changedIds(a: Draft, b: Draft): string[] {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].filter((id) => a[id] !== b[id]);
}
