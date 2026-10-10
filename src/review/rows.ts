// The review list's rows and the selection rules that move over them.

import type { ReceiptMeta, Transaction } from "../lib/tauri";
import { assignableReceipts, needsDecision, openCandidates } from "./effective";

export type ListRow = { kind: "transaction"; id: string; tx: Transaction } | { kind: "reimbursement"; id: string; receipt: ReceiptMeta };

export function reimbursementId(receipt: Pick<ReceiptMeta, "file">): string {
  return `reimbursement:${receipt.file}`;
}

/** Transactions first, then the reimbursements, in the order given. */
export function buildRows(transactions: Transaction[], reimbursements: ReceiptMeta[]): ListRow[] {
  return [
    ...transactions.map((tx): ListRow => ({ kind: "transaction", id: tx.id, tx })),
    ...reimbursements.map((receipt): ListRow => ({ kind: "reimbursement", id: reimbursementId(receipt), receipt })),
  ];
}

export function isPending(row: ListRow): boolean {
  return row.kind === "transaction" && needsDecision(row.tx);
}

/** The first row that needs a decision, or the first row when none does. */
export function initialSelection(rows: ListRow[]): ListRow | null {
  return rows.find(isPending) ?? rows[0] ?? null;
}

/**
 * The selected row while it is listed. Otherwise the row now at `fallbackIndex`, kept within the
 * list, so a decided row that leaves the list hands the selection to the one after it.
 */
export function resolveSelection(rows: ListRow[], selectedId: string | null, fallbackIndex = 0): ListRow | null {
  const kept = selectedId === null ? undefined : rows.find((row) => row.id === selectedId);
  if (kept) {
    return kept;
  }
  if (rows.length === 0) {
    return null;
  }
  return rows[Math.min(Math.max(fallbackIndex, 0), rows.length - 1)];
}

/** The index of the nearest row after (1) or before (-1) `from` that needs a decision, or -1. */
export function findPending(rows: ListRow[], from: number, direction: 1 | -1): number {
  for (let index = from + direction; index >= 0 && index < rows.length; index += direction) {
    if (isPending(rows[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * The receipts the inspector offers for a row: a REVIEW transaction's open candidates, the pool
 * receipts that fit an UNMATCHED one, a MATCHED one's receipts, or the reimbursement itself.
 */
export function rowReceipts(row: ListRow | null, pool: ReceiptMeta[], claimed: Set<string>): ReceiptMeta[] {
  if (!row) {
    return [];
  }
  if (row.kind === "reimbursement") {
    return [row.receipt];
  }
  switch (row.tx.status) {
    case "REVIEW":
      return openCandidates(row.tx, claimed);
    case "UNMATCHED":
      return assignableReceipts(pool, row.tx);
    case "MATCHED":
    default:
      return row.tx.receipt_meta;
  }
}
